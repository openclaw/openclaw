#include <stdint.h>

#include <atomic>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include <node_api.h>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace {

typedef enum pqt_status {
  PQT_STATUS_OK = 0,
  PQT_STATUS_ERROR = 1,
  PQT_STATUS_INVALID_ARGUMENT = 2,
} pqt_status_t;

typedef enum pqt_backend {
  PQT_BACKEND_METAL = 2,
} pqt_backend_t;

typedef struct pqt_runner pqt_runner_t;

typedef struct pqt_runner_config {
  const char* model_path;
  const char* tokenizer_path;
  const char* data_path;
  pqt_backend_t backend;
  int warmup;
} pqt_runner_config_t;

typedef struct pqt_transcribe_config {
  int max_new_tokens;
  float temperature;
} pqt_transcribe_config_t;

typedef void (*pqt_token_callback_t)(const char* piece, void* user_data);

typedef pqt_status_t (*pqt_runner_create_fn)(
    const pqt_runner_config_t* config,
    pqt_runner_t** out_runner);
typedef void (*pqt_runner_destroy_fn)(pqt_runner_t* runner);
typedef pqt_status_t (*pqt_runner_transcribe_fn)(
    pqt_runner_t* runner,
    const float* audio_data,
    int64_t num_samples,
    const pqt_transcribe_config_t* config,
    pqt_token_callback_t token_callback,
    void* user_data,
    int* out_num_generated_tokens);
typedef const char* (*pqt_last_error_fn)(void);

struct RuntimeSymbols {
#if defined(_WIN32)
  HMODULE library = nullptr;
#else
  void* library = nullptr;
#endif
  pqt_runner_create_fn runner_create = nullptr;
  pqt_runner_destroy_fn runner_destroy = nullptr;
  pqt_runner_transcribe_fn runner_transcribe = nullptr;
  pqt_last_error_fn last_error = nullptr;
};

struct RunnerHandle {
  RuntimeSymbols symbols;
  pqt_runner_t* runner = nullptr;
  std::atomic<uint32_t> refs{1};
};

struct RunnerBox {
  RunnerHandle* handle = nullptr;
};

struct AsyncTranscribeWork {
  napi_env env = nullptr;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  RunnerHandle* handle = nullptr;
  std::vector<float> samples;
  pqt_transcribe_config_t config{500, 0.0f};
  std::string transcript;
  std::string error;
};

std::string g_last_error;

void set_last_error(const std::string& message) {
  g_last_error = message;
}

void throw_last_error(napi_env env, const char* fallback) {
  const char* msg = g_last_error.empty() ? fallback : g_last_error.c_str();
  napi_throw_error(env, nullptr, msg);
}

bool get_named_string(
    napi_env env,
    napi_value object,
    const char* key,
    std::string* out_value) {
  napi_value value;
  napi_status status = napi_get_named_property(env, object, key, &value);
  if (status != napi_ok) {
    set_last_error(std::string("missing property: ") + key);
    return false;
  }

  napi_valuetype type;
  status = napi_typeof(env, value, &type);
  if (status != napi_ok || type != napi_string) {
    set_last_error(std::string("property must be a string: ") + key);
    return false;
  }

  size_t length = 0;
  status = napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  if (status != napi_ok) {
    set_last_error(std::string("failed to read string length for: ") + key);
    return false;
  }

  std::string buffer(length + 1, '\0');
  status =
      napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
  if (status != napi_ok) {
    set_last_error(std::string("failed to read string value for: ") + key);
    return false;
  }
  buffer.resize(length);
  *out_value = std::move(buffer);
  return true;
}

bool get_named_optional_string(
    napi_env env,
    napi_value object,
    const char* key,
    std::string* out_value) {
  bool has_property = false;
  napi_status status = napi_has_named_property(env, object, key, &has_property);
  if (status != napi_ok || !has_property) {
    out_value->clear();
    return true;
  }
  return get_named_string(env, object, key, out_value);
}

bool get_named_optional_bool(
    napi_env env,
    napi_value object,
    const char* key,
    bool default_value,
    bool* out_value) {
  bool has_property = false;
  napi_status status = napi_has_named_property(env, object, key, &has_property);
  if (status != napi_ok || !has_property) {
    *out_value = default_value;
    return true;
  }

  napi_value value;
  status = napi_get_named_property(env, object, key, &value);
  if (status != napi_ok) {
    set_last_error(std::string("failed to read bool property: ") + key);
    return false;
  }

  napi_valuetype type;
  status = napi_typeof(env, value, &type);
  if (status != napi_ok || type != napi_boolean) {
    set_last_error(std::string("property must be a boolean: ") + key);
    return false;
  }

  bool result = false;
  status = napi_get_value_bool(env, value, &result);
  if (status != napi_ok) {
    set_last_error(std::string("failed to read bool value for: ") + key);
    return false;
  }

  *out_value = result;
  return true;
}

bool parse_backend(const std::string& backend, pqt_backend_t* out_backend) {
  if (backend == "metal") {
    *out_backend = PQT_BACKEND_METAL;
    return true;
  }
  set_last_error("backend must be 'metal'");
  return false;
}

void close_library(RuntimeSymbols* symbols) {
  if (symbols == nullptr || symbols->library == nullptr) {
    return;
  }
#if defined(_WIN32)
  FreeLibrary(symbols->library);
#else
  dlclose(symbols->library);
#endif
  symbols->library = nullptr;
}

template <typename Fn>
bool load_symbol(RuntimeSymbols* symbols, const char* name, Fn* out_fn) {
#if defined(_WIN32)
  FARPROC symbol = GetProcAddress(symbols->library, name);
  if (symbol == nullptr) {
    set_last_error(std::string("failed to load symbol: ") + name);
    return false;
  }
  *out_fn = reinterpret_cast<Fn>(symbol);
#else
  dlerror();
  void* symbol = dlsym(symbols->library, name);
  const char* error = dlerror();
  if (error != nullptr || symbol == nullptr) {
    set_last_error(std::string("failed to load symbol: ") + name);
    return false;
  }
  *out_fn = reinterpret_cast<Fn>(symbol);
#endif
  return true;
}

bool load_runtime_symbols(const std::string& library_path, RuntimeSymbols* out_symbols) {
  RuntimeSymbols symbols;
#if defined(_WIN32)
  symbols.library = LoadLibraryA(library_path.c_str());
  if (symbols.library == nullptr) {
    set_last_error("failed to load runtime library");
    return false;
  }
#else
  symbols.library = dlopen(library_path.c_str(), RTLD_NOW | RTLD_GLOBAL);
  if (symbols.library == nullptr) {
    const char* dl_error = dlerror();
    set_last_error(
        std::string("failed to load runtime library: ") +
        (dl_error == nullptr ? "unknown error" : dl_error));
    return false;
  }
#endif

  if (!load_symbol(&symbols, "pqt_runner_create", &symbols.runner_create) ||
      !load_symbol(&symbols, "pqt_runner_destroy", &symbols.runner_destroy) ||
      !load_symbol(&symbols, "pqt_runner_transcribe", &symbols.runner_transcribe) ||
      !load_symbol(&symbols, "pqt_last_error", &symbols.last_error)) {
    close_library(&symbols);
    return false;
  }

  *out_symbols = symbols;
  return true;
}

void destroy_runner_handle(RunnerHandle* handle) {
  if (handle == nullptr) {
    return;
  }
  if (handle->runner != nullptr && handle->symbols.runner_destroy != nullptr) {
    handle->symbols.runner_destroy(handle->runner);
    handle->runner = nullptr;
  }
  close_library(&handle->symbols);
  delete handle;
}

void retain_runner_handle(RunnerHandle* handle) {
  if (handle != nullptr) {
    handle->refs.fetch_add(1, std::memory_order_relaxed);
  }
}

void release_runner_handle(RunnerHandle* handle) {
  if (handle == nullptr) {
    return;
  }
  if (handle->refs.fetch_sub(1, std::memory_order_acq_rel) == 1) {
    destroy_runner_handle(handle);
  }
}

void finalize_runner_box(napi_env /*env*/, void* data, void* /*hint*/) {
  auto* box = static_cast<RunnerBox*>(data);
  if (box == nullptr) {
    return;
  }
  release_runner_handle(box->handle);
  box->handle = nullptr;
  delete box;
}

void append_piece_callback(const char* piece, void* user_data) {
  if (piece == nullptr || user_data == nullptr) {
    return;
  }
  auto* out = static_cast<std::string*>(user_data);
  out->append(piece);
}

napi_value create_runner(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_status status = napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (status != napi_ok || argc != 1) {
    napi_throw_error(env, nullptr, "createRunner expects one config object argument");
    return nullptr;
  }

  napi_valuetype type;
  status = napi_typeof(env, argv[0], &type);
  if (status != napi_ok || type != napi_object) {
    napi_throw_error(env, nullptr, "createRunner config must be an object");
    return nullptr;
  }

  std::string runtime_library_path;
  std::string backend;
  std::string model_path;
  std::string tokenizer_path;
  std::string data_path;
  bool warmup = true;

  if (!get_named_string(env, argv[0], "runtimeLibraryPath", &runtime_library_path) ||
      !get_named_string(env, argv[0], "backend", &backend) ||
      !get_named_string(env, argv[0], "modelPath", &model_path) ||
      !get_named_string(env, argv[0], "tokenizerPath", &tokenizer_path) ||
      !get_named_optional_string(env, argv[0], "dataPath", &data_path) ||
      !get_named_optional_bool(env, argv[0], "warmup", true, &warmup)) {
    throw_last_error(env, "invalid createRunner config");
    return nullptr;
  }

  pqt_backend_t parsed_backend = PQT_BACKEND_METAL;
  if (!parse_backend(backend, &parsed_backend)) {
    throw_last_error(env, "invalid backend");
    return nullptr;
  }

  RuntimeSymbols symbols;
  if (!load_runtime_symbols(runtime_library_path, &symbols)) {
    throw_last_error(env, "failed to load runtime symbols");
    return nullptr;
  }

  pqt_runner_t* runner = nullptr;
  pqt_runner_config_t config{
      model_path.c_str(),
      tokenizer_path.c_str(),
      data_path.empty() ? nullptr : data_path.c_str(),
      parsed_backend,
      warmup ? 1 : 0};

  pqt_status_t create_status = symbols.runner_create(&config, &runner);
  if (create_status != PQT_STATUS_OK || runner == nullptr) {
    const char* runtime_error = symbols.last_error == nullptr ? nullptr : symbols.last_error();
    set_last_error(
        runtime_error != nullptr ? runtime_error : "pqt_runner_create failed");
    close_library(&symbols);
    throw_last_error(env, "pqt_runner_create failed");
    return nullptr;
  }

  auto* handle = new RunnerHandle();
  handle->symbols = symbols;
  handle->runner = runner;

  auto* box = new RunnerBox();
  box->handle = handle;

  napi_value external;
  status = napi_create_external(env, box, finalize_runner_box, nullptr, &external);
  if (status != napi_ok) {
    destroy_runner_handle(handle);
    delete box;
    napi_throw_error(env, nullptr, "failed to create runner handle");
    return nullptr;
  }

  return external;
}

RunnerBox* get_runner_box(napi_env env, napi_value value) {
  RunnerBox* box = nullptr;
  napi_status status = napi_get_value_external(env, value, reinterpret_cast<void**>(&box));
  if (status != napi_ok || box == nullptr || box->handle == nullptr) {
    napi_throw_error(env, nullptr, "invalid runner handle");
    return nullptr;
  }
  return box;
}

napi_value destroy_runner(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_status status = napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (status != napi_ok || argc != 1) {
    napi_throw_error(env, nullptr, "destroyRunner expects one runner handle argument");
    return nullptr;
  }

  RunnerBox* box = get_runner_box(env, argv[0]);
  if (box == nullptr) {
    return nullptr;
  }

  RunnerHandle* handle = box->handle;
  box->handle = nullptr;
  release_runner_handle(handle);

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

int32_t get_named_optional_int32(
    napi_env env,
    napi_value object,
    const char* key,
    int32_t default_value) {
  bool has_property = false;
  if (napi_has_named_property(env, object, key, &has_property) != napi_ok ||
      !has_property) {
    return default_value;
  }

  napi_value value;
  if (napi_get_named_property(env, object, key, &value) != napi_ok) {
    return default_value;
  }

  int32_t out = default_value;
  if (napi_get_value_int32(env, value, &out) != napi_ok) {
    return default_value;
  }
  return out;
}

double get_named_optional_double(
    napi_env env,
    napi_value object,
    const char* key,
    double default_value) {
  bool has_property = false;
  if (napi_has_named_property(env, object, key, &has_property) != napi_ok ||
      !has_property) {
    return default_value;
  }

  napi_value value;
  if (napi_get_named_property(env, object, key, &value) != napi_ok) {
    return default_value;
  }

  double out = default_value;
  if (napi_get_value_double(env, value, &out) != napi_ok) {
    return default_value;
  }
  return out;
}

void execute_transcribe(napi_env /*env*/, void* data) {
  auto* work = static_cast<AsyncTranscribeWork*>(data);
  if (work == nullptr || work->handle == nullptr) {
    return;
  }

  int generated_tokens = 0;
  pqt_status_t run_status = work->handle->symbols.runner_transcribe(
      work->handle->runner,
      work->samples.data(),
      static_cast<int64_t>(work->samples.size()),
      &work->config,
      append_piece_callback,
      &work->transcript,
      &generated_tokens);

  if (run_status != PQT_STATUS_OK) {
    const char* runtime_error =
        work->handle->symbols.last_error == nullptr ? nullptr : work->handle->symbols.last_error();
    work->error =
        runtime_error != nullptr ? runtime_error : "pqt_runner_transcribe failed";
  }
}

void complete_transcribe(napi_env env, napi_status status, void* data) {
  auto* work = static_cast<AsyncTranscribeWork*>(data);
  if (work == nullptr) {
    return;
  }

  if (status != napi_ok && work->error.empty()) {
    work->error = "transcribe async work failed";
  }

  if (!work->error.empty()) {
    napi_value message;
    napi_create_string_utf8(env, work->error.c_str(), work->error.size(), &message);
    napi_value error;
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, work->deferred, error);
  } else {
    napi_value out_text;
    napi_create_string_utf8(env, work->transcript.c_str(), work->transcript.size(), &out_text);
    napi_resolve_deferred(env, work->deferred, out_text);
  }

  if (work->work != nullptr) {
    napi_delete_async_work(env, work->work);
  }
  release_runner_handle(work->handle);
  delete work;
}

napi_value transcribe(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_status status = napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (status != napi_ok || argc < 2) {
    napi_throw_error(
        env, nullptr, "transcribe expects runner handle and PCM buffer");
    return nullptr;
  }

  RunnerBox* box = get_runner_box(env, argv[0]);
  if (box == nullptr || box->handle == nullptr) {
    return nullptr;
  }

  bool is_buffer = false;
  status = napi_is_buffer(env, argv[1], &is_buffer);
  if (status != napi_ok || !is_buffer) {
    napi_throw_error(env, nullptr, "transcribe expects a Buffer as second argument");
    return nullptr;
  }

  void* data = nullptr;
  size_t byte_length = 0;
  status = napi_get_buffer_info(env, argv[1], &data, &byte_length);
  if (status != napi_ok || data == nullptr) {
    napi_throw_error(env, nullptr, "failed to read PCM buffer");
    return nullptr;
  }
  if (byte_length % sizeof(float) != 0) {
    napi_throw_error(env, nullptr, "PCM buffer size must be aligned to float32");
    return nullptr;
  }

  pqt_transcribe_config_t config{500, 0.0f};
  if (argc >= 3) {
    napi_valuetype options_type;
    if (napi_typeof(env, argv[2], &options_type) == napi_ok &&
        options_type == napi_object) {
      config.max_new_tokens =
          get_named_optional_int32(env, argv[2], "maxNewTokens", config.max_new_tokens);
      config.temperature = static_cast<float>(
          get_named_optional_double(env, argv[2], "temperature", config.temperature));
    }
  }

  auto* work = new AsyncTranscribeWork();
  work->env = env;
  work->handle = box->handle;
  work->config = config;
  retain_runner_handle(work->handle);
  const size_t num_samples = byte_length / sizeof(float);
  work->samples.assign(
      static_cast<const float*>(data),
      static_cast<const float*>(data) + num_samples);

  napi_value promise;
  status = napi_create_promise(env, &work->deferred, &promise);
  if (status != napi_ok) {
    release_runner_handle(work->handle);
    delete work;
    napi_throw_error(env, nullptr, "failed to create transcribe promise");
    return nullptr;
  }

  napi_value resource_name;
  status = napi_create_string_utf8(env, "parakeet.transcribe", NAPI_AUTO_LENGTH, &resource_name);
  if (status != napi_ok) {
    release_runner_handle(work->handle);
    delete work;
    napi_throw_error(env, nullptr, "failed to create async resource name");
    return nullptr;
  }

  status = napi_create_async_work(
      env,
      nullptr,
      resource_name,
      execute_transcribe,
      complete_transcribe,
      work,
      &work->work);
  if (status != napi_ok) {
    release_runner_handle(work->handle);
    delete work;
    napi_throw_error(env, nullptr, "failed to create async transcribe work");
    return nullptr;
  }

  status = napi_queue_async_work(env, work->work);
  if (status != napi_ok) {
    napi_delete_async_work(env, work->work);
    release_runner_handle(work->handle);
    delete work;
    napi_throw_error(env, nullptr, "failed to queue async transcribe work");
    return nullptr;
  }

  return promise;
}

napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"createRunner", nullptr, create_runner, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"destroyRunner", nullptr, destroy_runner, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"transcribe", nullptr, transcribe, nullptr, nullptr, nullptr, napi_default, nullptr},
  };

  napi_status status = napi_define_properties(
      env,
      exports,
      sizeof(properties) / sizeof(properties[0]),
      properties);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "failed to export addon methods");
  }
  return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
