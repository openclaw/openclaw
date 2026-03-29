using System.Diagnostics;

namespace OpenClaw.MsTeams.Voice;

/// <summary>
/// Tracks worker capacity: active call count, CPU and memory usage, and
/// maximum concurrent call limit. Used by the HealthCheck gRPC endpoint
/// and by CallHandler to gate new call acceptance.
/// </summary>
public sealed class WorkerRegistry
{
    private volatile int _activeCalls;
    private readonly int _maxConcurrentCalls;

    /// <summary>
    /// Creates a new WorkerRegistry with the specified concurrent call limit.
    /// </summary>
    /// <param name="maxConcurrentCalls">Maximum allowed concurrent calls (default 10).</param>
    public WorkerRegistry(int maxConcurrentCalls = 10)
    {
        _maxConcurrentCalls = maxConcurrentCalls;
    }

    /// <summary>
    /// Number of currently active calls.
    /// </summary>
    public int ActiveCalls => _activeCalls;

    /// <summary>
    /// Maximum concurrent calls this worker will accept.
    /// </summary>
    public int MaxConcurrentCalls => _maxConcurrentCalls;

    /// <summary>
    /// Returns true if the worker can accept another call.
    /// </summary>
    public bool CanAcceptCall() => _activeCalls < _maxConcurrentCalls;

    /// <summary>
    /// Increments the active call count.
    /// </summary>
    public void IncrementCalls() => Interlocked.Increment(ref _activeCalls);

    /// <summary>
    /// Decrements the active call count.
    /// </summary>
    public void DecrementCalls()
    {
        var result = Interlocked.Decrement(ref _activeCalls);
        if (result < 0)
        {
            // Guard against underflow from duplicate cleanup paths.
            Interlocked.Exchange(ref _activeCalls, 0);
        }
    }

    /// <summary>
    /// Returns true if the worker is considered healthy. A worker is healthy
    /// when it is running and has not exceeded its call limit.
    /// </summary>
    public bool IsHealthy => _activeCalls <= _maxConcurrentCalls;

    /// <summary>
    /// Collects current CPU usage percentage for this process.
    /// Uses total processor time divided by wall-clock elapsed time across all cores.
    /// </summary>
    public double GetCpuUsagePercent()
    {
        try
        {
            var process = Process.GetCurrentProcess();
            var cpuTime = process.TotalProcessorTime;
            var uptime = DateTime.UtcNow - process.StartTime.ToUniversalTime();

            if (uptime.TotalMilliseconds <= 0) return 0;

            // Normalize to percentage across all logical processors.
            int processorCount = Environment.ProcessorCount;
            return (cpuTime.TotalMilliseconds / (uptime.TotalMilliseconds * processorCount)) * 100.0;
        }
        catch
        {
            return 0;
        }
    }

    /// <summary>
    /// Returns the current working set memory usage in bytes for this process.
    /// </summary>
    public ulong GetMemoryUsedBytes()
    {
        try
        {
            var process = Process.GetCurrentProcess();
            return (ulong)process.WorkingSet64;
        }
        catch
        {
            return 0;
        }
    }

    /// <summary>
    /// Builds a WorkerCapacity proto message with the current stats.
    /// </summary>
    public WorkerCapacity GetCapacity()
    {
        return new WorkerCapacity
        {
            ActiveCalls = (uint)_activeCalls,
            MaxConcurrentCalls = (uint)_maxConcurrentCalls,
            CpuUsagePercent = GetCpuUsagePercent(),
            MemoryUsedBytes = GetMemoryUsedBytes(),
        };
    }
}
