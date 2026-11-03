require "open3"

# Opt-in phase and incident evidence. Resource sampling belongs to ios-resource-timeline.mjs.
class ScreenshotDiagnostics
  attr_reader :events

  PROCESSES = %w[OpenClaw OpenClawUITests-Runner testmanagerd DTServiceHub Simulator com.apple.CoreSimulator.CoreSimulatorService].freeze

  def initialize(&persist)
    @events = []
    @persist = persist
  end

  def measure(phase, device: nil, udid: nil, log_path: nil)
    started_at = Time.now
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    event = { "phase" => phase, "deviceName" => device, "startedAt" => started_at.utc.iso8601 }
    @events << event
    persist
    result = yield
    event["outcome"] = "succeeded"
    result
  rescue StandardError
    event["outcome"] = "failed"
    event["crashes"] = crashes_since(started_at, udid)
    raise
  ensure
    if event
      event["durationSeconds"] = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(2)
      event["startup"] = startup_facts(log_path) if log_path
      persist
    end
  end

  def inventory_query(command)
    event = @events.last
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    elapsed = -> { ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round(3) }
    sample = { "startedAt" => Time.now.utc.iso8601(3) }
    stdout, stderr, status = Open3.popen3(*command) do |input, output, error, waiter|
      sample["spawnReturnedMs"] = elapsed.call
      input.close
      readers = [output, error].map do |stream|
        Thread.new do
          first = stream.read(1)
          first_at = elapsed.call if first
          rest = stream.read
          finished = elapsed.call
          [(first || +"").force_encoding(rest.encoding) << rest, first_at, finished]
        end
      end
      result = waiter.value
      # Parent-observed completion can itself be delayed by runner scheduling.
      sample["childWaitReturnedMs"] = elapsed.call
      captured = readers.map(&:value)
      %w[stdout stderr].zip(captured).each do |name, (data, first_at, eof_at)|
        sample["#{name}Bytes"] = data.bytesize
        sample["#{name}FirstByteMs"] = first_at
        sample["#{name}EofMs"] = eof_at
      end
      [captured[0][0], captured[1][0], result]
    end
    sample["capturedMs"] = elapsed.call
    sample["exitCode"] = status.exitstatus
    sample["terminationSignal"] = status.termsig
    handling_started = elapsed.call
    yield stdout, stderr, status
  ensure
    if sample
      sample["resultHandlingMs"] = (elapsed.call - handling_started).round(3) if handling_started
      sample["totalMs"] = elapsed.call
      sample["outcome"] = $! ? "failed" : "succeeded"
      # Persist with the existing phase boundary, adding no filesystem probes or writes.
      (event["inventoryQueries"] ||= []) << sample
    end
  end

  private

  def persist
    @persist.call
  rescue SystemCallError
    UI.important("Could not save the optional screenshot diagnostic sample.")
  end

  def startup_facts(path)
    facts = { "testCaseStarts" => 0, "instrumentsConnectionTimeout" => false, "runnerBootstrapFailure" => false, "stalledWait" => false }
    File.foreach(path) do |line|
      line = line.scrub
      facts["testCaseStarts"] += 1 if line.match?(/Test Case .* started\./)
      facts["instrumentsConnectionTimeout"] = true if line.include?("com.apple.instruments.deviceservice.lockdown") && line.include?("timed out")
      facts["runnerBootstrapFailure"] = true if line.include?("operation never finished bootstrapping")
      facts["stalledWait"] = true if line.include?("handleStalledWait:")
    end
    facts
  rescue SystemCallError
    { "unavailable" => true }
  end

  def crashes_since(started_at, udid)
    directories = [File.expand_path("~/Library/Logs/DiagnosticReports"), "/Library/Logs/DiagnosticReports"]
    if udid
      directories << File.expand_path("~/Library/Developer/CoreSimulator/Devices/#{udid}/data/Library/Logs/CrashReporter")
    end
    directories.flat_map { |directory| Dir[File.join(directory, "*.ips")] }
      .select { |path| File.mtime(path) >= started_at && File.size(path) <= 10 * 1024 * 1024 }
      .sort_by { |path| File.mtime(path) }.last(10).filter_map do |path|
        contents = File.read(path)
        report = begin
          JSON.parse(contents)
        rescue JSON::ParserError
          JSON.parse(contents.split("\n", 2).last)
        end
        name = report["procName"]
        next unless PROCESSES.include?(name)
        thread = Array(report["threads"]).find { |entry| entry["triggered"] }
        frames = Array(thread && thread["frames"]).first(12).filter_map do |frame|
          symbol = frame["symbol"].to_s
          next unless symbol.length <= 240 && symbol.match?(/\A[+\-\[A-Za-z_][A-Za-z0-9_ .():<>\[\]+\-]*\z/)
          { "symbol" => symbol }
        end
        {
          "process" => name,
          "exception" => report.fetch("exception", {}).slice("type", "signal").select { |_key, value| value.to_s.match?(/\A[A-Z_0-9]+\z/) },
          "termination" => report.fetch("termination", {}).slice("namespace", "code").select { |_key, value| value.is_a?(Numeric) || value.to_s.match?(/\A[A-Z_0-9]+\z/) },
          "triggeredThreadFrames" => frames
        }
      rescue JSON::ParserError, SystemCallError, TypeError
        nil
      end
  rescue StandardError
    []
  end
end
