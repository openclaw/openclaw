#include <libproc.h>
#include <mach/mach_time.h>
#include <sys/resource.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
 struct rusage_info_v4 r = {0};
 if (argc != 2 || proc_pid_rusage(atoi(argv[1]), RUSAGE_INFO_V4, (rusage_info_t *)&r)) return 1;
 mach_timebase_info_data_t timebase; mach_timebase_info(&timebase);
 double scale = (double)timebase.numer / timebase.denom / 1e6;
 printf("{\"diskReadBytes\":%llu,\"childUserMs\":%.6f,\"childSystemMs\":%.6f,\"selfUserMs\":%.6f}\n", r.ri_diskio_bytesread, r.ri_child_user_time * scale, r.ri_child_system_time * scale, r.ri_user_time * scale);
 return 0;
}
