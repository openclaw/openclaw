require "open3"
require "tempfile"

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
      observer = Thread.new do
        next if waiter.join(5)

        sample["stallProbe"] = inventory_stall_probe(waiter)
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
      sample["capturedMs"] = elapsed.call
      observer.value
      sample["observerJoinMs"] = (elapsed.call - sample["capturedMs"]).round(3)
      [captured[0][0], captured[1][0], result]
    end
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

  def inventory_stall_probe(waiter)
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    facts = { "outcome" => "unavailable", "startedAt" => Time.now.utc.iso8601(3) }
    facts["before"] = inventory_child_facts(waiter.pid)
    # A CPU probe can time out under the same load we are investigating.
    # The live waiter still identifies the inventory child owned by this query.
    return facts unless waiter.alive?

    Tempfile.create("ios-inventory-stack-") do |report|
      facts["sampleOutcome"] = diagnostic_command(
        ["/usr/bin/sample", waiter.pid.to_s, "1", "10", "-file", report.path],
        output: File::NULL, timeout: 3
      )
      facts["frames"] = sanitized_inventory_frames(report) if report.size <= 2 * 1024 * 1024
    end
    facts["after"] = inventory_child_facts(waiter.pid) if waiter.alive?
    facts["outcome"] = "collected" if facts["sampleOutcome"] == "succeeded" && facts["frames"]&.any?
    facts
  rescue StandardError
    facts
  ensure
    facts["durationMs"] = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round(3)
  end

  def inventory_child_facts(pid)
    Tempfile.create("ios-inventory-cpu-") do |report|
      outcome = diagnostic_command(["/bin/ps", "-p", pid.to_s, "-o", "time=,state=,comm="], output: report.path, timeout: 1)
      return nil unless outcome == "succeeded" && report.size <= 4096

      match = report.read.match(/\A\s*(?:(\d+)-)?([\d:.]+)\s+([A-Za-z+<>=-]+)\s+(.+?)\s*\z/)
      return nil unless match && %w[xcrun simctl].include?(File.basename(match[4]))

      seconds = match[1].to_i * 86_400 + match[2].split(":").reduce(0.0) { |sum, part| sum * 60 + part.to_f }
      { "cpuMs" => (seconds * 1000).round(3), "state" => match[3] }
    end
  end

  def diagnostic_command(command, output:, timeout:)
    pid = Process.spawn(*command, in: File::NULL, out: output, err: File::NULL, pgroup: true)
    process = Process.detach(pid)
    return "timed-out" unless process.join(timeout)

    process.value.success? ? "succeeded" : "failed"
  ensure
    if process&.alive?
      begin
        Process.kill("KILL", -pid)
      rescue Errno::ESRCH
        nil
      end
      process.join
    end
  end

  def sanitized_inventory_frames(report)
    graph = false
    thread = 0
    frames = []
    report.each_line do |line|
      if line.start_with?("Call graph:")
        graph = true
        next
      end
      next unless graph
      break if line.start_with?("Total number in stack", "Binary Images:")
      thread += 1 if line.match?(/\A\s*\d+ Thread_\d+/)
      match = line.match(/\A([ |:+!]*)(\d+) (.+?)  \(in [A-Za-z0-9_.-]+\)/)
      next unless match && match[3].length <= 240 && match[3].match?(/\A[+\-\[A-Za-z_][A-Za-z0-9_ .():<>\[\]+\-]*\z/)

      frames << { "thread" => thread, "depth" => match[1].length, "samples" => match[2].to_i, "symbol" => match[3] }
      break if frames.length == 160
    end
    frames
  end

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
