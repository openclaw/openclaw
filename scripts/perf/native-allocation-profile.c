// Synthetic Linux profiling only; compile with matching Node headers and -shared -fPIC -ldl.
#include <dlfcn.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>

typedef int (*ctl_fn)(const char *, void *, size_t *, void *, size_t);
static ctl_fn ctl;

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value stats(napi_env env, napi_callback_info info) {
  (void)info;
  uint64_t epoch = 1;
  size_t length = sizeof(epoch);
  if (ctl("epoch", &epoch, &length, &epoch, sizeof(epoch))) {
    return fail(env, "epoch refresh failed");
  }
  napi_value result;
  napi_create_object(env, &result);
  const char *names[] = {"stats.allocated", "stats.active", "stats.resident",
                         "stats.metadata", "stats.mapped", "stats.retained", NULL};
  for (int i = 0; names[i]; i++) {
    size_t value = 0;
    length = sizeof(value);
    if (ctl(names[i], &value, &length, NULL, 0)) {
      return fail(env, names[i]);
    }
    napi_value number;
    napi_create_double(env, (double)value, &number);
    napi_set_named_property(env, result, names[i] + 6, number);
  }
  return result;
}

static napi_value dump(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t count = 1, length = 0;
  char path[4096];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1) {
    return fail(env, "dump requires a path");
  }
  if (napi_get_value_string_utf8(env, args[0], NULL, 0, &length) != napi_ok ||
      length >= sizeof(path)) {
    return fail(env, "invalid dump path");
  }
  napi_get_value_string_utf8(env, args[0], path, sizeof(path), &length);
  const char *destination = path;
  if (ctl("prof.dump", NULL, NULL, &destination, sizeof(destination))) {
    return fail(env, "prof.dump failed");
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  ctl = (ctl_fn)dlsym(RTLD_DEFAULT, "mallctl");
  if (!ctl) {
    return fail(env, "jemalloc must be preloaded");
  }
  bool enabled = false;
  size_t length = sizeof(enabled);
  if (ctl("opt.prof", &enabled, &length, NULL, 0) || !enabled) {
    return fail(env, "jemalloc profiling must be enabled");
  }
  napi_value fn;
  napi_create_function(env, "stats", NAPI_AUTO_LENGTH, stats, NULL, &fn);
  napi_set_named_property(env, exports, "stats", fn);
  napi_create_function(env, "dump", NAPI_AUTO_LENGTH, dump, NULL, &fn);
  napi_set_named_property(env, exports, "dump", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
