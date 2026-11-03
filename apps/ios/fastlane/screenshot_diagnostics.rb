# Opt-in phase and incident evidence. Resource sampling belongs to ios-resource-timeline.mjs.
class ScreenshotDiagnostics
  attr_reader :events

  PROCESSES = %w[OpenClaw OpenClawUITests-Runner testmanagerd DTServiceHub Simulator com.apple.CoreSimulator.CoreSimulatorService].freeze
  STARTUP_MARKERS = {
    "commandHeader" => "Command line invocation:",
    "packageGraphStarted" => "Resolve Package Graph",
    "packageGraphResolved" => "Resolved source packages:",
    "resultBundleAnnounced" => "Writing result bundle at path:",
    "runnerStarted" => "[Default] Running tests...",
    "suiteStarted" => "Test Suite 'Selected tests' started at"
  }.freeze

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
    if log_path
      event["startupProgressSeconds"] = {}
      observer = Thread.new do
        loop do
          observe_startup_progress(log_path, started, event.fetch("startupProgressSeconds"))
          sleep(1)
        end
      end
    end
    result = yield
    event["outcome"] = "succeeded"
    result
  rescue StandardError
    event["outcome"] = "failed"
    event["crashes"] = crashes_since(started_at, udid)
    raise
  ensure
    observer&.kill&.join
    if event
      observe_startup_progress(log_path, started, event.fetch("startupProgressSeconds")) if log_path
      event["durationSeconds"] = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(2)
      event["startup"] = startup_facts(log_path) if log_path
      persist
    end
  end

  private

  # Temporary diagnostic: observe the existing file without piping native output.
  # These are arrival times (up to one poll late); native buffering can delay them.
  def observe_startup_progress(path, started, progress)
    File.foreach(path) do |line|
      line = line.scrub
      STARTUP_MARKERS.each do |name, marker|
        next if progress.key?(name) || !line.include?(marker)
        progress[name] = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(2)
      end
    end
  rescue SystemCallError
    nil
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
