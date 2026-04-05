#ifndef SRC_NODE_API_H_
#define SRC_NODE_API_H_

#if defined(BUILDING_NODE_EXTENSION) && !defined(NAPI_EXTERN)
#ifdef _WIN32
// Building native addon against node
#define NAPI_EXTERN __declspec(dllimport)
#elif defined(__wasm__)
#define NAPI_EXTERN __attribute__((__import_module__("napi")))
#endif
#endif
#include "js_native_api.h"
#include "node_api_types.h"

struct uv_loop_s;  // Forward declaration.

#ifdef _WIN32
#define NAPI_MODULE_EXPORT __declspec(dllexport)
#else
#ifdef __EMSCRIPTEN__
#define NAPI_MODULE_EXPORT                                                     \
  __attribute__((visibility("default"))) __attribute__((used))
#else
#define NAPI_MODULE_EXPORT __attribute__((visibility("default")))
#endif
#endif

#if defined(__GNUC__)
#define NAPI_NO_RETURN __attribute__((noreturn))
#elif defined(_WIN32)
#define NAPI_NO_RETURN __declspec(noreturn)
#else
#define NAPI_NO_RETURN
#endif

// Used by deprecated registration method napi_module_register.
typedef struct napi_module {
  int nm_version;
  unsigned int nm_flags;
  const char* nm_filename;
  napi_addon_register_func nm_register_func;
  const char* nm_modname;
  void* nm_priv;
  void* reserved[4];
} napi_module;

#define NAPI_MODULE_VERSION 1

#define NAPI_MODULE_INITIALIZER_X(base, version)                               \
  NAPI_MODULE_INITIALIZER_X_HELPER(base, version)
#define NAPI_MODULE_INITIALIZER_X_HELPER(base, version) base##version

#ifdef __wasm__
#define NAPI_MODULE_INITIALIZER_BASE napi_register_wasm_v
#else
#define NAPI_MODULE_INITIALIZER_BASE napi_register_module_v
#endif

#define NODE_API_MODULE_GET_API_VERSION_BASE node_api_module_get_api_version_v

#define NAPI_MODULE_INITIALIZER                                                \
  NAPI_MODULE_INITIALIZER_X(NAPI_MODULE_INITIALIZER_BASE, NAPI_MODULE_VERSION)

#define NODE_API_MODULE_GET_API_VERSION                                        \
  NAPI_MODULE_INITIALIZER_X(NODE_API_MODULE_GET_API_VERSION_BASE,              \
                            NAPI_MODULE_VERSION)

#define NAPI_MODULE_INIT()                                                     \
  EXTERN_C_START                                                               \
  NAPI_MODULE_EXPORT int32_t NODE_API_MODULE_GET_API_VERSION(void) {           \
    return NAPI_VERSION;                                                       \
  }                                                                            \
  NAPI_MODULE_EXPORT napi_value NAPI_MODULE_INITIALIZER(napi_env env,          \
                                                        napi_value exports);   \
  EXTERN_C_END                                                                 \
  napi_value NAPI_MODULE_INITIALIZER(napi_env env, napi_value exports)

#define NAPI_MODULE(modname, regfunc)                                          \
  NAPI_MODULE_INIT() { return regfunc(env, exports); }

// Deprecated. Use NAPI_MODULE.
#define NAPI_MODULE_X(modname, regfunc, priv, flags)                           \
  NAPI_MODULE(modname, regfunc)

EXTERN_C_START

// Deprecated. Replaced by symbol-based registration defined by NAPI_MODULE
// and NAPI_MODULE_INIT macros.
NAPI_EXTERN void NAPI_CDECL
napi_module_register(napi_module* mod);

NAPI_EXTERN NAPI_NO_RETURN void NAPI_CDECL
napi_fatal_error(const char* location,
                 size_t location_len,
                 const char* message,
                 size_t message_len);

// Methods for custom handling of async operations
NAPI_EXTERN napi_status NAPI_CDECL
napi_async_init(napi_env env,
                napi_value async_resource,
                napi_value async_resource_name,
                napi_async_context* result);

NAPI_EXTERN napi_status NAPI_CDECL
napi_async_destroy(napi_env env, napi_async_context async_context);

NAPI_EXTERN napi_status NAPI_CDECL
napi_make_callback(napi_env env,
                   napi_async_context async_context,
                   napi_value recv,
                   napi_value func,
                   size_t argc,
                   const napi_value* argv,
                   napi_value* result);

// Methods to provide node::Buffer functionality with napi types
NAPI_EXTERN napi_status NAPI_CDECL napi_create_buffer(napi_env env,
                                                      size_t length,
                                                      void** data,
                                                      napi_value* result);
#ifndef NODE_API_NO_EXTERNAL_BUFFERS_ALLOWED
NAPI_EXTERN napi_status NAPI_CDECL
napi_create_external_buffer(napi_env env,
                            size_t length,
                            void* data,
                            node_api_basic_finalize finalize_cb,
                            void* finalize_hint,
                            napi_value* result);
#endif  // NODE_API_NO_EXTERNAL_BUFFERS_ALLOWED

#if NAPI_VERSION >= 10

NAPI_EXTERN napi_status NAPI_CDECL
node_api_create_buffer_from_arraybuffer(napi_env env,
                                        napi_value arraybuffer,
                                        size_t byte_offset,
                                        size_t byte_length,
                                        napi_value* result);
#endif  // NAPI_VERSION >= 10

NAPI_EXTERN napi_status NAPI_CDECL napi_create_buffer_copy(napi_env env,
                                                           size_t length,
                                                           const void* data,
                                                           void** result_data,
                                                           napi_value* result);
NAPI_EXTERN napi_status NAPI_CDECL napi_is_buffer(napi_env env,
                                                  napi_value value,
                                                  bool* result);
NAPI_EXTERN napi_status NAPI_CDECL napi_get_buffer_info(napi_env env,
                                                        napi_value value,
                                                        void** data,
                                                        size_t* length);

// Methods to manage simple async operations
NAPI_EXTERN napi_status NAPI_CDECL
napi_create_async_work(napi_env env,
                       napi_value async_resource,
                       napi_value async_resource_name,
                       napi_async_execute_callback execute,
                       napi_async_complete_callback complete,
                       void* data,
                       napi_async_work* result);
NAPI_EXTERN napi_status NAPI_CDECL napi_delete_async_work(napi_env env,
                                                          napi_async_work work);
NAPI_EXTERN napi_status NAPI_CDECL napi_queue_async_work(node_api_basic_env env,
                                                         napi_async_work work);
NAPI_EXTERN napi_status NAPI_CDECL
napi_cancel_async_work(node_api_basic_env env, napi_async_work work);

// version management
NAPI_EXTERN napi_status NAPI_CDECL napi_get_node_version(
    node_api_basic_env env, const napi_node_version** version);

#if NAPI_VERSION >= 2

// Return the current libuv event loop for a given environment
NAPI_EXTERN napi_status NAPI_CDECL
napi_get_uv_event_loop(node_api_basic_env env, struct uv_loop_s** loop);

#endif  // NAPI_VERSION >= 2

#if NAPI_VERSION >= 3

NAPI_EXTERN napi_status NAPI_CDECL napi_fatal_exception(napi_env env,
                                                        napi_value err);

NAPI_EXTERN napi_status NAPI_CDECL napi_add_env_cleanup_hook(
    node_api_basic_env env, napi_cleanup_hook fun, void* arg);

NAPI_EXTERN napi_status NAPI_CDECL napi_remove_env_cleanup_hook(
    node_api_basic_env env, napi_cleanup_hook fun, void* arg);

NAPI_EXTERN napi_status NAPI_CDECL
napi_open_callback_scope(napi_env env,
                         napi_value resource_object,
                         napi_async_context context,
                         napi_callback_scope* result);

NAPI_EXTERN napi_status NAPI_CDECL
napi_close_callback_scope(napi_env env, napi_callback_scope scope);

#endif  // NAPI_VERSION >= 3

#if NAPI_VERSION >= 4

// Calling into JS from other threads
NAPI_EXTERN napi_status NAPI_CDECL
napi_create_threadsafe_function(napi_env env,
                                napi_value func,
                                napi_value async_resource,
                                napi_value async_resource_name,
                                size_t max_queue_size,
                                size_t initial_thread_count,
                                void* thread_finalize_data,
                                napi_finalize thread_finalize_cb,
                                void* context,
                                napi_threadsafe_function_call_js call_js_cb,
                                napi_threadsafe_function* result);

NAPI_EXTERN napi_status NAPI_CDECL napi_get_threadsafe_function_context(
    napi_threadsafe_function func, void** result);

NAPI_EXTERN napi_status NAPI_CDECL
napi_call_threadsafe_function(napi_threadsafe_function func,
                              void* data,
                              napi_threadsafe_function_call_mode is_blocking);

NAPI_EXTERN napi_status NAPI_CDECL
napi_acquire_threadsafe_function(napi_threadsafe_function func);

NAPI_EXTERN napi_status NAPI_CDECL napi_release_threadsafe_function(
    napi_threadsafe_function func, napi_threadsafe_function_release_mode mode);

NAPI_EXTERN napi_status NAPI_CDECL napi_unref_threadsafe_function(
    node_api_basic_env env, napi_threadsafe_function func);

NAPI_EXTERN napi_status NAPI_CDECL napi_ref_threadsafe_function(
    node_api_basic_env env, napi_threadsafe_function func);

#endif  // NAPI_VERSION >= 4

#if NAPI_VERSION >= 8

NAPI_EXTERN napi_status NAPI_CDECL
napi_add_async_cleanup_hook(node_api_basic_env env,
                            napi_async_cleanup_hook hook,
                            void* arg,
                            napi_async_cleanup_hook_handle* remove_handle);

NAPI_EXTERN napi_status NAPI_CDECL
napi_remove_async_cleanup_hook(napi_async_cleanup_hook_handle remove_handle);

#endif  // NAPI_VERSION >= 8

#if NAPI_VERSION >= 9

NAPI_EXTERN napi_status NAPI_CDECL
node_api_get_module_file_name(node_api_basic_env env, const char** result);

#endif  // NAPI_VERSION >= 9

EXTERN_C_END

#endif  // SRC_NODE_API_H_
