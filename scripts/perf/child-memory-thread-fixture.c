// Linux-only quiet forest: every descendant is spawned by a nonleader thread.
// cc -O2 -pthread child-memory-thread-fixture.c -o /tmp/thread-fixture
// /tmp/thread-fixture forest 20 14 24 /tmp/roots.json
// The default example produces 280 processes and 6,720 threads, excluding the
// controller. Use an isolated container; SIGTERM cleans up owned process groups.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *executable;
static int process_count, thread_count;
static atomic_int ready;
static pid_t *roots;
static int roots_started;
static volatile sig_atomic_t stopping;

static void fail(const char *operation) {
  perror(operation);
  exit(1);
}

static void stop(int signal_number) {
  (void)signal_number;
  stopping = 1;
}

static pid_t start_process(const char *mode, int processes, int threads, int group) {
  int pipe_fds[2];
  if (pipe(pipe_fds)) fail("pipe");
  char process_arg[32], thread_arg[32], ready_arg[32];
  snprintf(process_arg, sizeof(process_arg), "%d", processes);
  snprintf(thread_arg, sizeof(thread_arg), "%d", threads);
  snprintf(ready_arg, sizeof(ready_arg), "%d", pipe_fds[1]);
  pid_t pid = fork();
  if (pid < 0) fail("fork");
  if (!pid) {
    close(pipe_fds[0]);
    if (group && setpgid(0, 0)) _exit(2);
    execl(executable, executable, mode, process_arg, thread_arg, ready_arg, NULL);
    _exit(2);
  }
  close(pipe_fds[1]);
  if (group) roots[roots_started++] = pid;
  char marker;
  ssize_t bytes;
  do {
    bytes = read(pipe_fds[0], &marker, 1);
  } while (bytes < 0 && errno == EINTR && !stopping);
  close(pipe_fds[0]);
  if (bytes != 1 || marker != 'R') {
    fprintf(stderr, "Fixture child %d failed readiness\n", pid);
    exit(1);
  }
  return pid;
}

static void *worker(void *spawn_children) {
  if (spawn_children) {
    for (int index = 1; index < process_count; index++) {
      start_process("leaf", 1, thread_count, 0);
    }
  }
  atomic_fetch_add(&ready, 1);
  for (;;) pause();
  return NULL;
}

static void cleanup(void) {
  for (int index = 0; index < roots_started; index++) kill(-roots[index], SIGKILL);
  for (int index = 0; index < roots_started; index++) {
    while (waitpid(roots[index], NULL, 0) < 0 && errno == EINTR) {}
  }
  free(roots);
}

int main(int argc, char **argv) {
  if (argc < 5) {
    fprintf(stderr, "Usage: %s forest <roots> <processes/root> <threads/process> <roots.json>\n", argv[0]);
    return 1;
  }
  executable = argv[0];
  if (!strcmp(argv[1], "forest")) {
    if (argc != 6) return 1;
    int root_count = atoi(argv[2]);
    process_count = atoi(argv[3]);
    thread_count = atoi(argv[4]);
    if (root_count < 1 || process_count < 1 || thread_count < 2) return 1;
    roots = calloc((size_t)root_count, sizeof(*roots));
    if (!roots) fail("calloc");
    atexit(cleanup);
    struct sigaction action = {.sa_handler = stop};
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
    for (int index = 0; index < root_count && !stopping; index++) {
      start_process("root", process_count, thread_count, 1);
    }
    if (stopping) return 1;
    FILE *output = fopen(argv[5], "w");
    if (!output) fail("fopen");
    fputc('[', output);
    for (int index = 0; index < root_count; index++) {
      fprintf(output, "%s%d", index ? "," : "", roots[index]);
    }
    fputs("]\n", output);
    if (fclose(output)) fail("fclose");
    printf("FOREST_READY processes=%d threads=%d\n", root_count * process_count,
           root_count * process_count * thread_count);
    fflush(stdout);
    while (!stopping) pause();
    return 0;
  }
  process_count = atoi(argv[2]);
  thread_count = atoi(argv[3]);
  int ready_fd = atoi(argv[4]);
  if (fcntl(ready_fd, F_SETFD, FD_CLOEXEC)) fail("fcntl");
  pthread_attr_t attributes;
  pthread_attr_init(&attributes);
  pthread_attr_setstacksize(&attributes, 128 * 1024);
  for (int index = 1; index < thread_count; index++) {
    pthread_t thread;
    int result = pthread_create(&thread, &attributes, worker,
                               index == 1 && !strcmp(argv[1], "root") ? &ready : NULL);
    if (result) {
      errno = result;
      fail("pthread_create");
    }
    pthread_detach(thread);
  }
  pthread_attr_destroy(&attributes);
  while (atomic_load(&ready) != thread_count - 1) usleep(1000);
  if (write(ready_fd, "R", 1) != 1) fail("write readiness");
  close(ready_fd);
  for (;;) pause();
}
