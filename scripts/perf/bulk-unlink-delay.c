// Synthetic syscall delay. Inject only into disposable proof processes.
// macOS: cc -dynamiclib -o delay.dylib scripts/perf/bulk-unlink-delay.c
// Linux: cc -shared -fPIC -o delay.so scripts/perf/bulk-unlink-delay.c -ldl
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/syscall.h>

static void delay(const char *name) {
  static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
  static double deadline;
  static char group[128];
  if (!strstr(name, "slow-unlink-")) return;
  const char *log = getenv("BULK_UNLINK_LOG");
  if (!log) return;
  unsigned long long thread;
#ifdef __APPLE__
  uint64_t tid;
  pthread_threadid_np(NULL, &tid);
  thread = tid;
#else
  thread = syscall(SYS_gettid);
#endif
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  const char *marker = strstr(name, "slow-unlink-");
  char key[128];
  snprintf(key, sizeof(key), "%s", marker);
  char *last = strrchr(key, '-');
  if (last) *last = 0;
  pthread_mutex_lock(&mutex);
  if (strcmp(group, key)) {
    snprintf(group, sizeof(group), "%s", key);
    deadline = now.tv_sec + now.tv_nsec / 1e9 + 1;
  }
  double remaining = deadline - now.tv_sec - now.tv_nsec / 1e9;
  pthread_mutex_unlock(&mutex);
  if (remaining <= 0) return;
  int fd = open(log, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) {
    dprintf(fd, "%d %llu %.6f enter\n", getpid(), thread,
            now.tv_sec + now.tv_nsec / 1e9);
    close(fd);
  }
  struct timespec wait = {.tv_sec = (long)remaining,
                         .tv_nsec = (long)((remaining - (long)remaining) * 1e9)};
  nanosleep(&wait, NULL);
  clock_gettime(CLOCK_MONOTONIC, &now);
  fd = open(log, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) {
    dprintf(fd, "%d %llu %.6f leave\n", getpid(), thread,
            now.tv_sec + now.tv_nsec / 1e9);
    close(fd);
  }
}
#ifdef __APPLE__
#define HOOK(name) delayed_##name
#define INTERPOSE(name) \
  __attribute__((used)) static struct { const void *replacement; const void *original; } \
  hook_##name __attribute__((section("__DATA,__interpose"))) = {(const void *)HOOK(name), (const void *)name};
#else
#define HOOK(name) name
#define INTERPOSE(name)
#endif
int HOOK(unlink)(const char *name) {
  delay(name);
#ifdef __APPLE__
  return syscall(SYS_unlink, name);
#else
  int (*original)(const char *) = dlsym(RTLD_NEXT, "unlink");
  return original(name);
#endif
}
int HOOK(unlinkat)(int fd, const char *name, int flags) {
  delay(name);
#ifdef __APPLE__
  return syscall(SYS_unlinkat, fd, name, flags);
#else
  int (*original)(int, const char *, int) = dlsym(RTLD_NEXT, "unlinkat");
  return original(fd, name, flags);
#endif
}
INTERPOSE(unlink)
INTERPOSE(unlinkat)
