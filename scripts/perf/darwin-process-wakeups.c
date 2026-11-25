// Benchmark-only Darwin endpoint counters for explicit owned Chromium PIDs.
#define _DARWIN_C_SOURCE 1
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("Expected explicit owned Chromium PIDs\n", stderr);
    return 2;
  }
  mach_timebase_info_data_t timebase;
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.denom) {
    fputs("Darwin timebase unavailable\n", stderr);
    return 2;
  }
  uint64_t started = mach_continuous_time();
  printf("{\"sampleStartMach\":\"%" PRIu64 "\",\"timebase\":{\"numer\":%u,\"denom\":%u},\"processes\":[",
         started, timebase.numer, timebase.denom);
  for (int index = 1; index < argc; ++index) {
    if (index > 1) putchar(',');
    char *end;
    errno = 0;
    long parsed = strtol(argv[index], &end, 10);
    if (errno || *end || parsed <= 0 || parsed > INT_MAX) {
      fputs("{\"error\":\"invalid-pid\"}", stdout);
      continue;
    }
    int pid = (int)parsed;
    struct proc_bsdinfo identity = {0};
    errno = 0;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &identity, sizeof(identity)) != (int)sizeof(identity)) {
      printf("{\"pid\":%d,\"error\":\"pidinfo\",\"errno\":%d}", pid, errno);
      continue;
    }
    if (identity.pbi_uid != geteuid()) {
      printf("{\"pid\":%d,\"error\":\"different-uid\"}", pid);
      continue;
    }
    struct rusage_info_v0 usage = {0};
    errno = 0;
    if (proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&usage) != 0) {
      printf("{\"pid\":%d,\"error\":\"rusage\",\"errno\":%d}", pid, errno);
      continue;
    }
    printf("{\"pid\":%d,\"ppid\":%u,\"uid\":%u,\"startAbstime\":\"%" PRIu64
           "\",\"exitAbstime\":\"%" PRIu64 "\",\"interruptWakeups\":\"%" PRIu64
           "\",\"packageIdleWakeups\":\"%" PRIu64 "\"}",
           pid, identity.pbi_ppid, identity.pbi_uid, usage.ri_proc_start_abstime,
           usage.ri_proc_exit_abstime, usage.ri_interrupt_wkups, usage.ri_pkg_idle_wkups);
  }
  printf("],\"sampleEndMach\":\"%" PRIu64 "\"}\n", mach_continuous_time());
  return ferror(stdout) ? 2 : 0;
}
