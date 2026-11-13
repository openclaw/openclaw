#include <node_api.h>
#include <time.h>

// Linux getrusage accounting is too coarse for sub-millisecond owner timings.
static napi_value ReadThreadCpuMs(napi_env env, napi_callback_info info) {
  (void)info;
  struct timespec now;
  if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &now) != 0) {
    napi_throw_error(env, NULL, "Cannot read the thread CPU clock");
    return NULL;
  }
  napi_value result = NULL;
  if (napi_create_double(env, now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0,
                         &result) != napi_ok) {
    napi_throw_error(env, NULL, "Cannot return the thread CPU time");
    return NULL;
  }
  return result;
}

NAPI_MODULE_INIT() {
  (void)exports;
  napi_value clock = NULL;
  if (napi_create_function(env, "threadCpuMs", NAPI_AUTO_LENGTH, ReadThreadCpuMs,
                           NULL, &clock) != napi_ok) {
    napi_throw_error(env, NULL, "Cannot create the thread CPU clock");
    return NULL;
  }
  return clock;
}
