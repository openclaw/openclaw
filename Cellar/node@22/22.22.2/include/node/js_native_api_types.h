#ifndef SRC_JS_NATIVE_API_TYPES_H_
#define SRC_JS_NATIVE_API_TYPES_H_

// Use INT_MAX, this should only be consumed by the pre-processor anyway.
#define NAPI_VERSION_EXPERIMENTAL 2147483647
#ifndef NAPI_VERSION
#ifdef NAPI_EXPERIMENTAL
#define NAPI_VERSION NAPI_VERSION_EXPERIMENTAL
#else
// The baseline version for Node-API.
// NAPI_VERSION controls which version is used by default when compiling
// a native addon. If the addon developer wants to use functions from a
// newer Node-API version not yet available in all LTS versions, they can
// set NAPI_VERSION to explicitly depend on that version.
#define NAPI_VERSION 8
#endif
#endif

// This file needs to be compatible with C compilers.
// This is a public include file, and these includes have essentially
// become part of its API.
#include <stddef.h>  // NOLINT(modernize-deprecated-headers)
#include <stdint.h>  // NOLINT(modernize-deprecated-headers)

#if !defined __cplusplus || (defined(_MSC_VER) && _MSC_VER < 1900)
typedef uint16_t char16_t;
#endif

#ifndef NAPI_CDECL
#ifdef _WIN32
#define NAPI_CDECL __cdecl
#else
#define NAPI_CDECL
#endif
#endif

// JSVM API types are all opaque pointers for ABI stability
// typedef undefined structs instead of void* for compile time type safety
typedef struct napi_env__* napi_env;

// We need to mark APIs which can be called during garbage collection (GC),
// meaning that they do not affect the state of the JS engine, and can
// therefore be called synchronously from a finalizer that itself runs
// synchronously during GC. Such APIs can receive either a `napi_env` or a
// `node_api_basic_env` as their first parameter, because we should be able to
// also call them during normal, non-garbage-collecting operations, whereas
// APIs that affect the state of the JS engine can only receive a `napi_env` as
// their first parameter, because we must not call them during GC. In lieu of
// inheritance, we use the properties of the const qualifier to accomplish
// this, because both a const and a non-const value can be passed to an API
// expecting a const value, but only a non-const value can be passed to an API
// expecting a non-const value.
//
// In conjunction with appropriate CFLAGS to warn us if we're passing a const
// (basic) environment into an API that expects a non-const environment, and
// the definition of basic finalizer function pointer types below, which
// receive a basic environment as their first parameter, and can thus only call
// basic APIs (unless the user explicitly casts the environment), we achieve
// the ability to ensure at compile time that we do not call APIs that affect
// the state of the JS engine from a synchronous (basic) finalizer.
#if !defined(NAPI_EXPERIMENTAL) ||                                             \
    (defined(NAPI_EXPERIMENTAL) &&                                             \
     (defined(NODE_API_EXPERIMENTAL_NOGC_ENV_OPT_OUT) ||                       \
      defined(NODE_API_EXPERIMENTAL_BASIC_ENV_OPT_OUT)))
typedef struct napi_env__* node_api_nogc_env;
#else
typedef const struct napi_env__* node_api_nogc_env;
#endif
typedef node_api_nogc_env node_api_basic_env;

typedef struct napi_value__* napi_value;
typedef struct napi_ref__* napi_ref;
typedef struct napi_handle_scope__* napi_handle_scope;
typedef struct napi_escapable_handle_scope__* napi_escapable_handle_scope;
typedef struct napi_callback_info__* napi_callback_info;
typedef struct napi_deferred__* napi_deferred;

typedef enum {
  napi_default = 0,
  napi_writable = 1 << 0,
  napi_enumerable = 1 << 1,
  napi_configurable = 1 << 2,

  // Used with napi_define_class to distinguish static properties
  // from instance properties. Ignored by napi_define_properties.
  napi_static = 1 << 10,

#if NAPI_VERSION >= 8
  // Default for class methods.
  napi_default_method = napi_writable | napi_configurable,

  // Default for object properties, like in JS obj[prop].
  napi_default_jsproperty = napi_writable | napi_enumerable | napi_configurable,
#endif  // NAPI_VERSION >= 8
} napi_property_attributes;

typedef enum {
  // ES6 types (corresponds to typeof)
  napi_undefined,
  napi_null,
  napi_boolean,
  napi_number,
  napi_string,
  napi_symbol,
  napi_object,
  napi_function,
  napi_external,
  napi_bigint,
} napi_valuetype;

typedef enum {
  napi_int8_array,
  napi_uint8_array,
  napi_uint8_clamped_array,
  napi_int16_array,
  napi_uint16_array,
  napi_int32_array,
  napi_uint32_array,
  napi_float32_array,
  napi_float64_array,
  napi_bigint64_array,
  napi_biguint64_array,
} napi_typedarray_type;

typedef enum {
  napi_ok,
  napi_invalid_arg,
  napi_object_expected,
  napi_string_expected,
  napi_name_expected,
  napi_function_expected,
  napi_number_expected,
  napi_boolean_expected,
  napi_array_expected,
  napi_generic_failure,
  napi_pending_exception,
  napi_cancelled,
  napi_escape_called_twice,
  napi_handle_scope_mismatch,
  napi_callback_scope_mismatch,
  napi_queue_full,
  napi_closing,
  napi_bigint_expected,
  napi_date_expected,
  napi_arraybuffer_expected,
  napi_detachable_arraybuffer_expected,
  napi_would_deadlock,  // unused
  napi_no_external_buffers_allowed,
  napi_cannot_run_js,
} napi_status;
// Note: when adding a new enum value to `napi_status`, please also update
//   * `const int last_status` in the definition of `napi_get_last_error_info()'
//     in file js_native_api_v8.cc.
//   * `const char* error_messages[]` in file js_native_api_v8.cc with a brief
//     message explaining the error.
//   * the definition of `napi_status` in doc/api/n-api.md to reflect the newly
//     added value(s).

typedef napi_value(NAPI_CDECL* napi_callback)(napi_env env,
                                              napi_callback_info info);
typedef void(NAPI_CDECL* napi_finalize)(napi_env env,
                                        void* finalize_data,
                                        void* finalize_hint);

#if !defined(NAPI_EXPERIMENTAL) ||                                             \
    (defined(NAPI_EXPERIMENTAL) &&                                             \
     (defined(NODE_API_EXPERIMENTAL_NOGC_ENV_OPT_OUT) ||                       \
      defined(NODE_API_EXPERIMENTAL_BASIC_ENV_OPT_OUT)))
typedef napi_finalize node_api_nogc_finalize;
#else
typedef void(NAPI_CDECL* node_api_nogc_finalize)(node_api_nogc_env env,
                                                 void* finalize_data,
                                                 void* finalize_hint);
#endif
typedef node_api_nogc_finalize node_api_basic_finalize;

typedef struct {
  // One of utf8name or name should be NULL.
  const char* utf8name;
  napi_value name;

  napi_callback method;
  napi_callback getter;
  napi_callback setter;
  napi_value value;

  napi_property_attributes attributes;
  void* data;
} napi_property_descriptor;

typedef struct {
  const char* error_message;
  void* engine_reserved;
  uint32_t engine_error_code;
  napi_status error_code;
} napi_extended_error_info;

#if NAPI_VERSION >= 6
typedef enum {
  napi_key_include_prototypes,
  napi_key_own_only
} napi_key_collection_mode;

typedef enum {
  napi_key_all_properties = 0,
  napi_key_writable = 1,
  napi_key_enumerable = 1 << 1,
  napi_key_configurable = 1 << 2,
  napi_key_skip_strings = 1 << 3,
  napi_key_skip_symbols = 1 << 4
} napi_key_filter;

typedef enum {
  napi_key_keep_numbers,
  napi_key_numbers_to_strings
} napi_key_conversion;
#endif  // NAPI_VERSION >= 6

#if NAPI_VERSION >= 8
typedef struct {
  uint64_t lower;
  uint64_t upper;
} napi_type_tag;
#endif  // NAPI_VERSION >= 8

#endif  // SRC_JS_NATIVE_API_TYPES_H_
