export declare function isPidAlive(pid: number): boolean;
/**
 * Read the process start time (field 22 "starttime") from /proc/<pid>/stat.
 * Returns the value in clock ticks since system boot, or null on non-Linux
 * platforms or if the proc file can't be read.
 *
 * This is used to detect PID recycling: if two readings for the same PID
 * return different starttimes, the PID has been reused by a different process.
 */
export declare function getProcessStartTime(pid: number): number | null;
