// Linux/glibc allocation requests for agent-git-wrapper.py; timing runs omit this preload.
// cc -shared -fPIC -o /absolute/alloc.so scripts/perf/agent-git-wrapper-alloc.c -ldl
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/syscall.h>

extern void *__libc_malloc(size_t);
extern void *__libc_calloc(size_t, size_t);
extern void *__libc_realloc(void *, size_t);
static unsigned long calls, bytes;
static pid_t owner;
static int emitted;

static void account(size_t n) {
  pid_t pid = getpid();
  if (owner != pid) { owner = pid; calls = bytes = 0; emitted = 0; }
  calls++;
  bytes += n;
}
void *malloc(size_t n) { account(n); return __libc_malloc(n); }
void *calloc(size_t n, size_t s) { account(n * s); return __libc_calloc(n, s); }
void *realloc(void *p, size_t n) { account(n); return __libc_realloc(p, n); }
static void emit(void) {
  if (owner != getpid() || emitted++) return;
  const char *p = getenv("OPENCLAW_ALLOC_LOG");
  if (!p) return;
  char buffer[160];
  int length = snprintf(buffer, sizeof(buffer), "{\"calls\":%lu,\"bytes\":%lu}\n", calls, bytes);
  int fd = open(p, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) { write(fd, buffer, length); close(fd); }
}
__attribute__((destructor)) static void finish(void) { emit(); }
int execve(const char *p, char *const args[], char *const env[]) {
  int (*next)(const char *, char *const[], char *const[]) = dlsym(RTLD_NEXT, "execve");
  // exec replaces the shell without running its destructor.
  emit();
  return next(p, args, env);
}

// Dash terminates with _exit, including the parent of a non-exec Git probe.
void _exit(int code) {
  emit();
  syscall(SYS_exit_group, code);
  __builtin_unreachable();
}

// Keep counters private: vfork would let the child's accounting overwrite its parent.
// This allocation-only run uses fork; its timings are deliberately discarded.
pid_t vfork(void) { return fork(); }
