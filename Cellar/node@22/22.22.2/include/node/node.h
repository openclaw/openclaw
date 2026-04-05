// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

#ifndef SRC_NODE_H_
#define SRC_NODE_H_

#ifdef _WIN32
# ifndef BUILDING_NODE_EXTENSION
#  define NODE_EXTERN __declspec(dllexport)
# else
#  define NODE_EXTERN __declspec(dllimport)
# endif
#else
# define NODE_EXTERN __attribute__((visibility("default")))
#endif

// Declarations annotated with NODE_EXTERN_PRIVATE do not form part of
// the public API. They are implementation details that can and will
// change between releases, even in semver patch releases. Do not use
// any such symbol in external code.
#ifdef NODE_SHARED_MODE
#define NODE_EXTERN_PRIVATE NODE_EXTERN
#else
#define NODE_EXTERN_PRIVATE
#endif

#ifdef BUILDING_NODE_EXTENSION
# undef BUILDING_V8_SHARED
# undef BUILDING_UV_SHARED
# define USING_V8_SHARED 1
# define USING_UV_SHARED 1
#endif

// This should be defined in make system.
// See issue https://github.com/nodejs/node-v0.x-archive/issues/1236
#if defined(__MINGW32__) || defined(_MSC_VER)
#ifndef _WIN32_WINNT
# define _WIN32_WINNT 0x0600  // Windows Server 2008
#endif

#ifndef NOMINMAX
# define NOMINMAX
#endif

#endif

#if defined(_MSC_VER)
#define PATH_MAX MAX_PATH
#endif

#ifdef _WIN32
#define SIGQUIT 3
#define SIGKILL 9
#endif

#include "v8.h"  // NOLINT(build/include_order)

#include "v8-platform.h"  // NOLINT(build/include_order)
#include "node_version.h"  // NODE_MODULE_VERSION

#include "node_api.h"

#include <functional>
#include <memory>
#include <optional>
#include <ostream>

// We cannot use __POSIX__ in this header because that's only defined when
// building Node.js.
#ifndef _WIN32
#include <signal.h>
#endif  // _WIN32

#define NODE_MAKE_VERSION(major, minor, patch)                                \
  ((major) * 0x1000 + (minor) * 0x100 + (patch))

#ifdef __clang__
# define NODE_CLANG_AT_LEAST(major, minor, patch)                             \
  (NODE_MAKE_VERSION(major, minor, patch) <=                                  \
      NODE_MAKE_VERSION(__clang_major__, __clang_minor__, __clang_patchlevel__))
#else
# define NODE_CLANG_AT_LEAST(major, minor, patch) (0)
#endif

#ifdef __GNUC__
# define NODE_GNUC_AT_LEAST(major, minor, patch)                              \
  (NODE_MAKE_VERSION(major, minor, patch) <=                                  \
      NODE_MAKE_VERSION(__GNUC__, __GNUC_MINOR__, __GNUC_PATCHLEVEL__))
#else
# define NODE_GNUC_AT_LEAST(major, minor, patch) (0)
#endif

#if defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS
# define NODE_DEPRECATED(message, declarator) declarator
#else  // NODE_WANT_INTERNALS
# if NODE_CLANG_AT_LEAST(2, 9, 0) || NODE_GNUC_AT_LEAST(4, 5, 0)
#  define NODE_DEPRECATED(message, declarator)                                 \
    __attribute__((deprecated(message))) declarator
# elif defined(_MSC_VER)
#  define NODE_DEPRECATED(message, declarator)                                 \
    __declspec(deprecated) declarator
# else
#  define NODE_DEPRECATED(message, declarator) declarator
# endif
#endif

// Forward-declare libuv loop
struct uv_loop_s;

// Forward-declare these functions now to stop MSVS from becoming
// terminally confused when it's done in node_internals.h
namespace node {

struct SnapshotData;

namespace tracing {

class TracingController;

}

NODE_EXTERN v8::Local<v8::Value> ErrnoException(v8::Isolate* isolate,
                                                int errorno,
                                                const char* syscall = nullptr,
                                                const char* message = nullptr,
                                                const char* path = nullptr);
NODE_EXTERN v8::Local<v8::Value> UVException(v8::Isolate* isolate,
                                             int errorno,
                                             const char* syscall = nullptr,
                                             const char* message = nullptr,
                                             const char* path = nullptr,
                                             const char* dest = nullptr);

NODE_DEPRECATED("Use ErrnoException(isolate, ...)",
                inline v8::Local<v8::Value> ErrnoException(
      int errorno,
      const char* syscall = nullptr,
      const char* message = nullptr,
      const char* path = nullptr) {
  return ErrnoException(v8::Isolate::GetCurrent(),
                        errorno,
                        syscall,
                        message,
                        path);
})

NODE_DEPRECATED("Use UVException(isolate, ...)",
                inline v8::Local<v8::Value> UVException(int errorno,
                                        const char* syscall = nullptr,
                                        const char* message = nullptr,
                                        const char* path = nullptr) {
  return UVException(v8::Isolate::GetCurrent(),
                     errorno,
                     syscall,
                     message,
                     path);
})

/*
 * These methods need to be called in a HandleScope.
 *
 * It is preferred that you use the `MakeCallback` overloads taking
 * `async_context` arguments.
 */

NODE_DEPRECATED("Use MakeCallback(..., async_context)",
                NODE_EXTERN v8::Local<v8::Value> MakeCallback(
                    v8::Isolate* isolate,
                    v8::Local<v8::Object> recv,
                    const char* method,
                    int argc,
                    v8::Local<v8::Value>* argv));
NODE_DEPRECATED("Use MakeCallback(..., async_context)",
                NODE_EXTERN v8::Local<v8::Value> MakeCallback(
                    v8::Isolate* isolate,
                    v8::Local<v8::Object> recv,
                    v8::Local<v8::String> symbol,
                    int argc,
                    v8::Local<v8::Value>* argv));
NODE_DEPRECATED("Use MakeCallback(..., async_context)",
                NODE_EXTERN v8::Local<v8::Value> MakeCallback(
                    v8::Isolate* isolate,
                    v8::Local<v8::Object> recv,
                    v8::Local<v8::Function> callback,
                    int argc,
                    v8::Local<v8::Value>* argv));

}  // namespace node

#include <cassert>
#include <cstdint>

#ifndef NODE_STRINGIFY
# define NODE_STRINGIFY(n) NODE_STRINGIFY_HELPER(n)
# define NODE_STRINGIFY_HELPER(n) #n
#endif

#ifdef _WIN32
#if !defined(_SSIZE_T_) && !defined(_SSIZE_T_DEFINED)
typedef intptr_t ssize_t;
# define _SSIZE_T_
# define _SSIZE_T_DEFINED
#endif
#else  // !_WIN32
# include <sys/types.h>  // size_t, ssize_t
#endif  // _WIN32


namespace node {

class IsolateData;
class Environment;
class MultiIsolatePlatform;
class InitializationResultImpl;

namespace ProcessInitializationFlags {
enum Flags : uint32_t {
  kNoFlags = 0,
  // Enable stdio inheritance, which is disabled by default.
  // This flag is also implied by kNoStdioInitialization.
  kEnableStdioInheritance = 1 << 0,
  // Disable reading the NODE_OPTIONS environment variable.
  kDisableNodeOptionsEnv = 1 << 1,
  // Do not parse CLI options.
  kDisableCLIOptions = 1 << 2,
  // Do not initialize ICU.
  kNoICU = 1 << 3,
  // Do not modify stdio file descriptor or TTY state.
  kNoStdioInitialization = 1 << 4,
  // Do not register Node.js-specific signal handlers
  // and reset other signal handlers to default state.
  kNoDefaultSignalHandling = 1 << 5,
  // Do not perform V8 initialization.
  kNoInitializeV8 = 1 << 6,
  // Do not initialize a default Node.js-provided V8 platform instance.
  kNoInitializeNodeV8Platform = 1 << 7,
  // Do not initialize OpenSSL config.
  kNoInitOpenSSL = 1 << 8,
  // Do not initialize Node.js debugging based on environment variables.
  kNoParseGlobalDebugVariables = 1 << 9,
  // Do not adjust OS resource limits for this process.
  kNoAdjustResourceLimits = 1 << 10,
  // Do not map code segments into large pages for this process.
  kNoUseLargePages = 1 << 11,
  // Skip printing output for --help, --version, --v8-options.
  kNoPrintHelpOrVersionOutput = 1 << 12,
  // Do not perform cppgc initialization. If set, the embedder must call
  // cppgc::InitializeProcess() before creating a Node.js environment
  // and call cppgc::ShutdownProcess() before process shutdown.
  kNoInitializeCppgc = 1 << 13,
  // Initialize the process for predictable snapshot generation.
  kGeneratePredictableSnapshot = 1 << 14,

  // Emulate the behavior of InitializeNodeWithArgs() when passing
  // a flags argument to the InitializeOncePerProcess() replacement
  // function.
  kLegacyInitializeNodeWithArgsBehavior =
      kNoStdioInitialization | kNoDefaultSignalHandling | kNoInitializeV8 |
      kNoInitializeNodeV8Platform | kNoInitOpenSSL |
      kNoParseGlobalDebugVariables | kNoAdjustResourceLimits |
      kNoUseLargePages | kNoPrintHelpOrVersionOutput | kNoInitializeCppgc,
};
}  // namespace ProcessInitializationFlags
namespace ProcessFlags = ProcessInitializationFlags;  // Legacy alias.

namespace StopFlags {
enum Flags : uint32_t {
  kNoFlags = 0,
  // Do not explicitly terminate the Isolate
  // when exiting the Environment.
  kDoNotTerminateIsolate = 1 << 0,
};
}  // namespace StopFlags

class NODE_EXTERN InitializationResult {
 public:
  virtual ~InitializationResult() = default;

  // Returns a suggested process exit code.
  virtual int exit_code() const = 0;

  // Returns 'true' if initialization was aborted early due to errors.
  virtual bool early_return() const = 0;

  // Returns the parsed list of non-Node.js arguments.
  virtual const std::vector<std::string>& args() const = 0;

  // Returns the parsed list of Node.js arguments.
  virtual const std::vector<std::string>& exec_args() const = 0;

  // Returns an array of errors. Note that these may be warnings
  // whose existence does not imply a non-zero exit code.
  virtual const std::vector<std::string>& errors() const = 0;

  // If kNoInitializeNodeV8Platform was not specified, the global Node.js
  // platform instance.
  virtual MultiIsolatePlatform* platform() const = 0;

 private:
  InitializationResult() = default;
  friend class InitializationResultImpl;
};

// TODO(addaleax): Officially deprecate this and replace it with something
// better suited for a public embedder API.
NODE_EXTERN int Start(int argc, char* argv[]);

// Tear down Node.js while it is running (there are active handles
// in the loop and / or actively executing JavaScript code).
NODE_EXTERN int Stop(Environment* env,
                     StopFlags::Flags flags = StopFlags::kNoFlags);

// Set up per-process state needed to run Node.js. This will consume arguments
// from argv, fill exec_argv, and possibly add errors resulting from parsing
// the arguments to `errors`. The return value is a suggested exit code for the
// program; If it is 0, then initializing Node.js succeeded.
// This runs a subset of the initialization performed by
// InitializeOncePerProcess(), which supersedes this function.
// The subset is roughly equivalent to the one given by
// `ProcessInitializationFlags::kLegacyInitializeNodeWithArgsBehavior`.
NODE_DEPRECATED("Use InitializeOncePerProcess() instead",
                NODE_EXTERN int InitializeNodeWithArgs(
                    std::vector<std::string>* argv,
                    std::vector<std::string>* exec_argv,
                    std::vector<std::string>* errors,
                    ProcessInitializationFlags::Flags flags =
                        ProcessInitializationFlags::kNoFlags));

// Set up per-process state needed to run Node.js. This will consume arguments
// from args, and return information about the initialization success,
// including the arguments split into argv/exec_argv, a list of potential
// errors encountered during initialization, and a potential suggested
// exit code.
NODE_EXTERN std::shared_ptr<InitializationResult> InitializeOncePerProcess(
    const std::vector<std::string>& args,
    ProcessInitializationFlags::Flags flags =
        ProcessInitializationFlags::kNoFlags);
// Undoes the initialization performed by InitializeOncePerProcess(),
// where cleanup is necessary.
NODE_EXTERN void TearDownOncePerProcess();
// Convenience overload for specifying multiple flags without having
// to worry about casts.
inline std::shared_ptr<InitializationResult> InitializeOncePerProcess(
    const std::vector<std::string>& args,
    std::initializer_list<ProcessInitializationFlags::Flags> list) {
  uint64_t flags_accum = ProcessInitializationFlags::kNoFlags;
  for (const auto flag : list) flags_accum |= static_cast<uint64_t>(flag);
  return InitializeOncePerProcess(
      args, static_cast<ProcessInitializationFlags::Flags>(flags_accum));
}

enum OptionEnvvarSettings {
  // Allow the options to be set via the environment variable, like
  // `NODE_OPTIONS`.
  kAllowedInEnvvar = 0,
  // Disallow the options to be set via the environment variable, like
  // `NODE_OPTIONS`.
  kDisallowedInEnvvar = 1,
  // Deprecated, use kAllowedInEnvvar instead.
  kAllowedInEnvironment = kAllowedInEnvvar,
  // Deprecated, use kDisallowedInEnvvar instead.
  kDisallowedInEnvironment = kDisallowedInEnvvar,
};

// Process the arguments and set up the per-process options.
// If the `settings` is set as OptionEnvvarSettings::kAllowedInEnvvar, the
// options that are allowed in the environment variable are processed. Options
// that are disallowed to be set via environment variable are processed as
// errors.
// Otherwise all the options that are disallowed (and those are allowed) to be
// set via environment variable are processed.
NODE_EXTERN int ProcessGlobalArgs(std::vector<std::string>* args,
                      std::vector<std::string>* exec_args,
                      std::vector<std::string>* errors,
                      OptionEnvvarSettings settings);

class NodeArrayBufferAllocator;

// An ArrayBuffer::Allocator class with some Node.js-specific tweaks. If you do
// not have to use another allocator, using this class is recommended:
// - It supports Buffer.allocUnsafe() and Buffer.allocUnsafeSlow() with
//   uninitialized memory.
// - It supports transferring, rather than copying, ArrayBuffers when using
//   MessagePorts.
class NODE_EXTERN ArrayBufferAllocator : public v8::ArrayBuffer::Allocator {
 public:
  // If `always_debug` is true, create an ArrayBuffer::Allocator instance
  // that performs additional integrity checks (e.g. make sure that only memory
  // that was allocated by the it is also freed by it).
  // This can also be set using the --debug-arraybuffer-allocations flag.
  static std::unique_ptr<ArrayBufferAllocator> Create(
      bool always_debug = false);

 private:
  virtual NodeArrayBufferAllocator* GetImpl() = 0;

  friend class IsolateData;
};

// Legacy equivalents for ArrayBufferAllocator::Create().
NODE_EXTERN ArrayBufferAllocator* CreateArrayBufferAllocator();
NODE_EXTERN void FreeArrayBufferAllocator(ArrayBufferAllocator* allocator);

class NODE_EXTERN IsolatePlatformDelegate {
 public:
  virtual std::shared_ptr<v8::TaskRunner> GetForegroundTaskRunner() = 0;
  virtual bool IdleTasksEnabled() = 0;
};

class NODE_EXTERN MultiIsolatePlatform : public v8::Platform {
 public:
  ~MultiIsolatePlatform() override = default;
  // Returns true if work was dispatched or executed. New tasks that are
  // posted during flushing of the queue are postponed until the next
  // flushing.
  virtual bool FlushForegroundTasks(v8::Isolate* isolate) = 0;
  virtual void DrainTasks(v8::Isolate* isolate) = 0;

  // This needs to be called between the calls to `Isolate::Allocate()` and
  // `Isolate::Initialize()`, so that initialization can already start
  // using the platform.
  // When using `NewIsolate()`, this is taken care of by that function.
  // This function may only be called once per `Isolate`.
  virtual void RegisterIsolate(v8::Isolate* isolate,
                               struct uv_loop_s* loop) = 0;
  // This method can be used when an application handles task scheduling on its
  // own through `IsolatePlatformDelegate`. Upon registering an isolate with
  // this overload any other method in this class with the exception of
  // `UnregisterIsolate` *must not* be used on that isolate.
  virtual void RegisterIsolate(v8::Isolate* isolate,
                               IsolatePlatformDelegate* delegate) = 0;

  // This function may only be called once per `Isolate`, and discard any
  // pending delayed tasks scheduled for that isolate.
  // This needs to be called right before calling `Isolate::Dispose()`.
  virtual void UnregisterIsolate(v8::Isolate* isolate) = 0;

  // The platform should call the passed function once all state associated
  // with the given isolate has been cleaned up. This can, but does not have to,
  // happen asynchronously.
  virtual void AddIsolateFinishedCallback(v8::Isolate* isolate,
                                          void (*callback)(void*),
                                          void* data) = 0;

  static std::unique_ptr<MultiIsolatePlatform> Create(
      int thread_pool_size,
      v8::TracingController* tracing_controller = nullptr,
      v8::PageAllocator* page_allocator = nullptr);
};

enum IsolateSettingsFlags {
  MESSAGE_LISTENER_WITH_ERROR_LEVEL = 1 << 0,
  DETAILED_SOURCE_POSITIONS_FOR_PROFILING = 1 << 1,
  SHOULD_NOT_SET_PROMISE_REJECTION_CALLBACK = 1 << 2,
  SHOULD_NOT_SET_PREPARE_STACK_TRACE_CALLBACK = 1 << 3,
  ALLOW_MODIFY_CODE_GENERATION_FROM_STRINGS_CALLBACK = 0, /* legacy no-op */
};

struct IsolateSettings {
  uint64_t flags = MESSAGE_LISTENER_WITH_ERROR_LEVEL |
      DETAILED_SOURCE_POSITIONS_FOR_PROFILING;
  v8::MicrotasksPolicy policy = v8::MicrotasksPolicy::kExplicit;

  // Error handling callbacks
  v8::Isolate::AbortOnUncaughtExceptionCallback
      should_abort_on_uncaught_exception_callback = nullptr;
  v8::FatalErrorCallback fatal_error_callback = nullptr;
  v8::OOMErrorCallback oom_error_callback = nullptr;
  v8::PrepareStackTraceCallback prepare_stack_trace_callback = nullptr;

  // Miscellaneous callbacks
  v8::PromiseRejectCallback promise_reject_callback = nullptr;
  v8::AllowWasmCodeGenerationCallback
      allow_wasm_code_generation_callback = nullptr;
  v8::ModifyCodeGenerationFromStringsCallback2
      modify_code_generation_from_strings_callback = nullptr;
};

// Represents a startup snapshot blob, e.g. created by passing
// --node-snapshot-main=entry.js to the configure script at build time,
// or by running Node.js with the --build-snapshot option.
//
// If used, the snapshot *must* have been built with the same Node.js
// version and V8 flags as the version that is currently running, and will
// be rejected otherwise.
// The same EmbedderSnapshotData instance *must* be passed to both
// `NewIsolate()` and `CreateIsolateData()`. The first `Environment` instance
// should be created with an empty `context` argument and will then
// use the main context included in the snapshot blob. It can be retrieved
// using `GetMainContext()`. `LoadEnvironment` can receive an empty
// `StartExecutionCallback` in this case.
// If V8 was configured with the shared-readonly-heap option, it requires
// all snapshots used to create `Isolate` instances to be identical.
// This option *must* be unset by embedders who wish to use the startup
// feature during the build step by passing the --disable-shared-readonly-heap
// flag to the configure script.
//
// The snapshot *must* be kept alive during the execution of the Isolate
// that was created using it.
//
// Snapshots are an *experimental* feature. In particular, the embedder API
// exposed through this class is subject to change or removal between Node.js
// versions, including possible API and ABI breakage.
class EmbedderSnapshotData {
 public:
  struct DeleteSnapshotData {
    void operator()(const EmbedderSnapshotData*) const;
  };
  using Pointer =
      std::unique_ptr<const EmbedderSnapshotData, DeleteSnapshotData>;

  // Return an EmbedderSnapshotData object that refers to the built-in
  // snapshot of Node.js. This can have been configured through e.g.
  // --node-snapshot-main=entry.js.
  static Pointer BuiltinSnapshotData();

  // Return an EmbedderSnapshotData object that is based on an input file.
  // Calling this method will consume but not close the FILE* handle.
  // The FILE* handle can be closed immediately following this call.
  // If the snapshot is invalid, this returns an empty pointer.
  static Pointer FromFile(FILE* in);
  static Pointer FromBlob(const std::vector<char>& in);
  static Pointer FromBlob(std::string_view in);

  // Write this EmbedderSnapshotData object to an output file.
  // Calling this method will not close the FILE* handle.
  // The FILE* handle can be closed immediately following this call.
  void ToFile(FILE* out) const;
  std::vector<char> ToBlob() const;

  // Returns whether custom snapshots can be used. Currently, this means
  // that V8 was configured without the shared-readonly-heap feature.
  static bool CanUseCustomSnapshotPerIsolate();

  EmbedderSnapshotData(const EmbedderSnapshotData&) = delete;
  EmbedderSnapshotData& operator=(const EmbedderSnapshotData&) = delete;
  EmbedderSnapshotData(EmbedderSnapshotData&&) = delete;
  EmbedderSnapshotData& operator=(EmbedderSnapshotData&&) = delete;

 protected:
  EmbedderSnapshotData(const SnapshotData* impl, bool owns_impl);

 private:
  const SnapshotData* impl_;
  bool owns_impl_;
  friend struct SnapshotData;
  friend class CommonEnvironmentSetup;
};

// Overriding IsolateSettings may produce unexpected behavior
// in Node.js core functionality, so proceed at your own risk.
NODE_EXTERN void SetIsolateUpForNode(v8::Isolate* isolate,
                                     const IsolateSettings& settings);

// Set a number of callbacks for the `isolate`, in particular the Node.js
// uncaught exception listener.
NODE_EXTERN void SetIsolateUpForNode(v8::Isolate* isolate);

// Creates a new isolate with Node.js-specific settings.
// This is a convenience method equivalent to using SetIsolateCreateParams(),
// Isolate::Allocate(), MultiIsolatePlatform::RegisterIsolate(),
// Isolate::Initialize(), and SetIsolateUpForNode().
NODE_EXTERN v8::Isolate* NewIsolate(
    ArrayBufferAllocator* allocator,
    struct uv_loop_s* event_loop,
    MultiIsolatePlatform* platform,
    const EmbedderSnapshotData* snapshot_data = nullptr,
    const IsolateSettings& settings = {});
NODE_EXTERN v8::Isolate* NewIsolate(
    std::shared_ptr<ArrayBufferAllocator> allocator,
    struct uv_loop_s* event_loop,
    MultiIsolatePlatform* platform,
    const EmbedderSnapshotData* snapshot_data = nullptr,
    const IsolateSettings& settings = {});

// Creates a new context with Node.js-specific tweaks.
NODE_EXTERN v8::Local<v8::Context> NewContext(
    v8::Isolate* isolate,
    v8::Local<v8::ObjectTemplate> object_template =
        v8::Local<v8::ObjectTemplate>());

// Runs Node.js-specific tweaks on an already constructed context
// Return value indicates success of operation
NODE_EXTERN v8::Maybe<bool> InitializeContext(v8::Local<v8::Context> context);

// If `platform` is passed, it will be used to register new Worker instances.
// It can be `nullptr`, in which case creating new Workers inside of
// Environments that use this `IsolateData` will not work.
NODE_EXTERN IsolateData* CreateIsolateData(
    v8::Isolate* isolate,
    struct uv_loop_s* loop,
    MultiIsolatePlatform* platform = nullptr,
    ArrayBufferAllocator* allocator = nullptr,
    const EmbedderSnapshotData* snapshot_data = nullptr);
NODE_EXTERN void FreeIsolateData(IsolateData* isolate_data);

struct ThreadId {
  uint64_t id = static_cast<uint64_t>(-1);
};
NODE_EXTERN ThreadId AllocateEnvironmentThreadId();

namespace EnvironmentFlags {
enum Flags : uint64_t {
  kNoFlags = 0,
  // Use the default behaviour for Node.js instances.
  kDefaultFlags = 1 << 0,
  // Controls whether this Environment is allowed to affect per-process state
  // (e.g. cwd, process title, uid, etc.).
  // This is set when using kDefaultFlags.
  kOwnsProcessState = 1 << 1,
  // Set if this Environment instance is associated with the global inspector
  // handling code (i.e. listening on SIGUSR1).
  // This is set when using kDefaultFlags.
  kOwnsInspector = 1 << 2,
  // Set if Node.js should not run its own esm loader. This is needed by some
  // embedders, because it's possible for the Node.js esm loader to conflict
  // with another one in an embedder environment, e.g. Blink's in Chromium.
  kNoRegisterESMLoader = 1 << 3,
  // Set this flag to make Node.js track "raw" file descriptors, i.e. managed
  // by fs.open() and fs.close(), and close them during FreeEnvironment().
  kTrackUnmanagedFds = 1 << 4,
  // Set this flag to force hiding console windows when spawning child
  // processes. This is usually used when embedding Node.js in GUI programs on
  // Windows.
  kHideConsoleWindows = 1 << 5,
  // Set this flag to disable loading native addons via `process.dlopen`.
  // This environment flag is especially important for worker threads
  // so that a worker thread can't load a native addon even if `execArgv`
  // is overwritten and `--no-addons` is not specified but was specified
  // for this Environment instance.
  kNoNativeAddons = 1 << 6,
  // Set this flag to disable searching modules from global paths like
  // $HOME/.node_modules and $NODE_PATH. This is used by standalone apps that
  // do not expect to have their behaviors changed because of globally
  // installed modules.
  kNoGlobalSearchPaths = 1 << 7,
  // Do not export browser globals like setTimeout, console, etc.
  kNoBrowserGlobals = 1 << 8,
  // Controls whether or not the Environment should call V8Inspector::create().
  // This control is needed by embedders who may not want to initialize the V8
  // inspector in situations where one has already been created,
  // e.g. Blink's in Chromium.
  kNoCreateInspector = 1 << 9,
  // Controls whether or not the InspectorAgent for this Environment should
  // call StartDebugSignalHandler. This control is needed by embedders who may
  // not want to allow other processes to start the V8 inspector.
  kNoStartDebugSignalHandler = 1 << 10,
  // Controls whether the InspectorAgent created for this Environment waits for
  // Inspector frontend events during the Environment creation. It's used to
  // call node::Stop(env) on a Worker thread that is waiting for the events.
  kNoWaitForInspectorFrontend = 1 << 11
};
}  // namespace EnvironmentFlags

enum class SnapshotFlags : uint32_t {
  kDefault = 0,
  // Whether code cache should be generated as part of the snapshot.
  // Code cache reduces the time spent on compiling functions included
  // in the snapshot at the expense of a bigger snapshot size and
  // potentially breaking portability of the snapshot.
  kWithoutCodeCache = 1 << 0,
};

struct SnapshotConfig {
  SnapshotFlags flags = SnapshotFlags::kDefault;

  // When builder_script_path is std::nullopt, the snapshot is generated as a
  // built-in snapshot instead of a custom one, and it's expected that the
  // built-in snapshot only contains states that reproduce in every run of the
  // application. The event loop won't be run when generating a built-in
  // snapshot, so asynchronous operations should be avoided.
  //
  // When builder_script_path is an std::string, it should match args[1]
  // passed to CreateForSnapshotting(). The embedder is also expected to use
  // LoadEnvironment() to run a script matching this path. In that case the
  // snapshot is generated as a custom snapshot and the event loop is run, so
  // the snapshot builder can execute asynchronous operations as long as they
  // are run to completion when the snapshot is taken.
  std::optional<std::string> builder_script_path;
};

struct InspectorParentHandle {
  virtual ~InspectorParentHandle() = default;
};

// TODO(addaleax): Maybe move per-Environment options parsing here.
// Returns nullptr when the Environment cannot be created e.g. there are
// pending JavaScript exceptions.
// `context` may be empty if an `EmbedderSnapshotData` instance was provided
// to `NewIsolate()` and `CreateIsolateData()`.
NODE_EXTERN Environment* CreateEnvironment(
    IsolateData* isolate_data,
    v8::Local<v8::Context> context,
    const std::vector<std::string>& args,
    const std::vector<std::string>& exec_args,
    EnvironmentFlags::Flags flags = EnvironmentFlags::kDefaultFlags,
    ThreadId thread_id = {} /* allocates a thread id automatically */,
    std::unique_ptr<InspectorParentHandle> inspector_parent_handle = {});

NODE_EXTERN Environment* CreateEnvironment(
    IsolateData* isolate_data,
    v8::Local<v8::Context> context,
    const std::vector<std::string>& args,
    const std::vector<std::string>& exec_args,
    EnvironmentFlags::Flags flags,
    ThreadId thread_id,
    std::unique_ptr<InspectorParentHandle> inspector_parent_handle,
    std::string_view thread_name);

// Returns a handle that can be passed to `LoadEnvironment()`, making the
// child Environment accessible to the inspector as if it were a Node.js Worker.
// `child_thread_id` can be created using `AllocateEnvironmentThreadId()`
// and then later passed on to `CreateEnvironment()` to create the child
// Environment, together with the inspector handle.
// This method should not be called while the parent Environment is active
// on another thread.
NODE_EXTERN std::unique_ptr<InspectorParentHandle> GetInspectorParentHandle(
    Environment* parent_env,
    ThreadId child_thread_id,
    const char* child_url);

NODE_EXTERN std::unique_ptr<InspectorParentHandle> GetInspectorParentHandle(
    Environment* parent_env,
    ThreadId child_thread_id,
    const char* child_url,
    const char* name);

NODE_EXTERN std::unique_ptr<InspectorParentHandle> GetInspectorParentHandle(
    Environment* parent_env,
    ThreadId child_thread_id,
    std::string_view child_url,
    std::string_view name);

struct StartExecutionCallbackInfo {
  v8::Local<v8::Object> process_object;
  v8::Local<v8::Function> native_require;
  v8::Local<v8::Function> run_cjs;
};

using StartExecutionCallback =
    std::function<v8::MaybeLocal<v8::Value>(const StartExecutionCallbackInfo&)>;
using EmbedderPreloadCallback =
    std::function<void(Environment* env,
                       v8::Local<v8::Value> process,
                       v8::Local<v8::Value> require)>;

// Run initialization for the environment.
//
// The |preload| function, usually used by embedders to inject scripts,
// will be run by Node.js before Node.js executes the entry point.
// The function is guaranteed to run before the user land module loader running
// any user code, so it is safe to assume that at this point, no user code has
// been run yet.
// The function will be executed with preload(process, require), and the passed
// require function has access to internal Node.js modules. There is no
// stability guarantee about the internals exposed to the internal require
// function. Expect breakages when updating Node.js versions if the embedder
// imports internal modules with the internal require function.
// Worker threads created in the environment will also respect The |preload|
// function, so make sure the function is thread-safe.
NODE_EXTERN v8::MaybeLocal<v8::Value> LoadEnvironment(
    Environment* env,
    StartExecutionCallback cb,
    EmbedderPreloadCallback preload = nullptr);
NODE_EXTERN v8::MaybeLocal<v8::Value> LoadEnvironment(
    Environment* env,
    std::string_view main_script_source_utf8,
    EmbedderPreloadCallback preload = nullptr);
NODE_EXTERN void FreeEnvironment(Environment* env);

// Set a callback that is called when process.exit() is called from JS,
// overriding the default handler.
// It receives the Environment* instance and the exit code as arguments.
// This could e.g. call Stop(env); in order to terminate execution and stop
// the event loop.
// The default handler disposes of the global V8 platform instance, if one is
// being used, and calls exit().
NODE_EXTERN void SetProcessExitHandler(
    Environment* env,
    std::function<void(Environment*, int)>&& handler);
NODE_EXTERN void DefaultProcessExitHandler(Environment* env, int exit_code);

// This may return nullptr if context is not associated with a Node instance.
NODE_EXTERN Environment* GetCurrentEnvironment(v8::Local<v8::Context> context);
NODE_EXTERN IsolateData* GetEnvironmentIsolateData(Environment* env);
NODE_EXTERN ArrayBufferAllocator* GetArrayBufferAllocator(IsolateData* data);
// This is mostly useful for Environment* instances that were created through
// a snapshot and have a main context that was read from that snapshot.
NODE_EXTERN v8::Local<v8::Context> GetMainContext(Environment* env);

[[noreturn]] NODE_EXTERN void OnFatalError(const char* location,
                                           const char* message);
NODE_EXTERN void PromiseRejectCallback(v8::PromiseRejectMessage message);
NODE_EXTERN bool AllowWasmCodeGenerationCallback(v8::Local<v8::Context> context,
                                            v8::Local<v8::String>);
NODE_EXTERN bool ShouldAbortOnUncaughtException(v8::Isolate* isolate);
NODE_EXTERN v8::MaybeLocal<v8::Value> PrepareStackTraceCallback(
    v8::Local<v8::Context> context,
    v8::Local<v8::Value> exception,
    v8::Local<v8::Array> trace);

// Writes a diagnostic report to a file. If filename is not provided, the
// default filename includes the date, time, PID, and a sequence number.
// The report's JavaScript stack trace is taken from err, if present.
// If isolate is nullptr, no information about the JavaScript environment
// is included in the report.
// Returns the filename of the written report.
NODE_EXTERN std::string TriggerNodeReport(v8::Isolate* isolate,
                                          const char* message,
                                          const char* trigger,
                                          const std::string& filename,
                                          v8::Local<v8::Value> error);
NODE_EXTERN std::string TriggerNodeReport(Environment* env,
                                          const char* message,
                                          const char* trigger,
                                          const std::string& filename,
                                          v8::Local<v8::Value> error);
NODE_EXTERN void GetNodeReport(v8::Isolate* isolate,
                               const char* message,
                               const char* trigger,
                               v8::Local<v8::Value> error,
                               std::ostream& out);
NODE_EXTERN void GetNodeReport(Environment* env,
                               const char* message,
                               const char* trigger,
                               v8::Local<v8::Value> error,
                               std::ostream& out);

// This returns the MultiIsolatePlatform used for an Environment or IsolateData
// instance, if one exists.
NODE_EXTERN MultiIsolatePlatform* GetMultiIsolatePlatform(Environment* env);
NODE_EXTERN MultiIsolatePlatform* GetMultiIsolatePlatform(IsolateData* env);

NODE_DEPRECATED("Use MultiIsolatePlatform::Create() instead",
    NODE_EXTERN MultiIsolatePlatform* CreatePlatform(
        int thread_pool_size,
        v8::TracingController* tracing_controller));
NODE_DEPRECATED("Use MultiIsolatePlatform::Create() instead",
    NODE_EXTERN void FreePlatform(MultiIsolatePlatform* platform));

// Get/set the currently active tracing controller. Using CreatePlatform()
// will implicitly set this by default. This is global and should be initialized
// along with the v8::Platform instance that is being used. `controller`
// is allowed to be `nullptr`.
// This is used for tracing events from Node.js itself. V8 uses the tracing
// controller returned from the active `v8::Platform` instance.
NODE_EXTERN v8::TracingController* GetTracingController();
NODE_EXTERN void SetTracingController(v8::TracingController* controller);

// Run `process.emit('beforeExit')` as it would usually happen when Node.js is
// run in standalone mode.
NODE_EXTERN v8::Maybe<bool> EmitProcessBeforeExit(Environment* env);
NODE_DEPRECATED("Use Maybe version (EmitProcessBeforeExit) instead",
    NODE_EXTERN void EmitBeforeExit(Environment* env));
// Run `process.emit('exit')` as it would usually happen when Node.js is run
// in standalone mode. The return value corresponds to the exit code.
NODE_EXTERN v8::Maybe<int> EmitProcessExit(Environment* env);
NODE_DEPRECATED("Use Maybe version (EmitProcessExit) instead",
    NODE_EXTERN int EmitExit(Environment* env));

// Runs hooks added through `AtExit()`. This is part of `FreeEnvironment()`,
// so calling it manually is typically not necessary.
NODE_EXTERN void RunAtExit(Environment* env);

// This may return nullptr if the current v8::Context is not associated
// with a Node instance.
NODE_EXTERN struct uv_loop_s* GetCurrentEventLoop(v8::Isolate* isolate);

// Runs the main loop for a given Environment. This roughly performs the
// following steps:
// 1. Call uv_run() on the event loop until it is drained.
// 2. Call platform->DrainTasks() on the associated platform/isolate.
//   3. If the event loop is alive again, go to Step 1.
// 4. Call EmitProcessBeforeExit().
//   5. If the event loop is alive again, go to Step 1.
// 6. Call EmitProcessExit() and forward the return value.
// If at any point node::Stop() is called, the function will attempt to return
// as soon as possible, returning an empty `Maybe`.
// This function only works if `env` has an associated `MultiIsolatePlatform`.
NODE_EXTERN v8::Maybe<int> SpinEventLoop(Environment* env);

NODE_EXTERN std::string GetAnonymousMainPath();

class NODE_EXTERN CommonEnvironmentSetup {
 public:
  ~CommonEnvironmentSetup();

  // Create a new CommonEnvironmentSetup, that is, a group of objects that
  // together form the typical setup for a single Node.js Environment instance.
  // If any error occurs, `*errors` will be populated and the returned pointer
  // will be empty.
  // env_args will be passed through as arguments to CreateEnvironment(), after
  // `isolate_data` and `context`.
  template <typename... EnvironmentArgs>
  static std::unique_ptr<CommonEnvironmentSetup> Create(
      MultiIsolatePlatform* platform,
      std::vector<std::string>* errors,
      EnvironmentArgs&&... env_args);
  template <typename... EnvironmentArgs>
  static std::unique_ptr<CommonEnvironmentSetup> CreateFromSnapshot(
      MultiIsolatePlatform* platform,
      std::vector<std::string>* errors,
      const EmbedderSnapshotData* snapshot_data,
      EnvironmentArgs&&... env_args);

  // Create an embedding setup which will be used for creating a snapshot
  // using CreateSnapshot().
  //
  // This will create and attach a v8::SnapshotCreator to this instance,
  // and the same restrictions apply to this instance that also apply to
  // other V8 snapshotting environments.
  // Not all Node.js APIs are supported in this case. Currently, there is
  // no support for native/host objects other than Node.js builtins
  // in the snapshot.
  //
  // If the embedder wants to use LoadEnvironment() later to run a snapshot
  // builder script they should make sure args[1] contains the path of the
  // snapshot script, which will be used to create __filename and __dirname
  // in the context where the builder script is run. If they do not want to
  // include the build-time paths into the snapshot, use the string returned
  // by GetAnonymousMainPath() as args[1] to anonymize the script.
  //
  // Snapshots are an *experimental* feature. In particular, the embedder API
  // exposed through this class is subject to change or removal between Node.js
  // versions, including possible API and ABI breakage.
  static std::unique_ptr<CommonEnvironmentSetup> CreateForSnapshotting(
      MultiIsolatePlatform* platform,
      std::vector<std::string>* errors,
      const std::vector<std::string>& args = {},
      const std::vector<std::string>& exec_args = {},
      const SnapshotConfig& snapshot_config = {});
  EmbedderSnapshotData::Pointer CreateSnapshot();

  struct uv_loop_s* event_loop() const;
  v8::SnapshotCreator* snapshot_creator();
  // Empty for snapshotting environments.
  std::shared_ptr<ArrayBufferAllocator> array_buffer_allocator() const;
  v8::Isolate* isolate() const;
  IsolateData* isolate_data() const;
  Environment* env() const;
  v8::Local<v8::Context> context() const;

  CommonEnvironmentSetup(const CommonEnvironmentSetup&) = delete;
  CommonEnvironmentSetup& operator=(const CommonEnvironmentSetup&) = delete;
  CommonEnvironmentSetup(CommonEnvironmentSetup&&) = delete;
  CommonEnvironmentSetup& operator=(CommonEnvironmentSetup&&) = delete;

 private:
  enum Flags : uint32_t {
    kNoFlags = 0,
    kIsForSnapshotting = 1,
  };

  struct Impl;
  Impl* impl_;

  CommonEnvironmentSetup(
      MultiIsolatePlatform*,
      std::vector<std::string>*,
      std::function<Environment*(const CommonEnvironmentSetup*)>);
  CommonEnvironmentSetup(
      MultiIsolatePlatform*,
      std::vector<std::string>*,
      const EmbedderSnapshotData*,
      uint32_t flags,
      std::function<Environment*(const CommonEnvironmentSetup*)>,
      const SnapshotConfig* config = nullptr);
};

// Implementation for CommonEnvironmentSetup::Create
template <typename... EnvironmentArgs>
std::unique_ptr<CommonEnvironmentSetup> CommonEnvironmentSetup::Create(
    MultiIsolatePlatform* platform,
    std::vector<std::string>* errors,
    EnvironmentArgs&&... env_args) {
  auto ret = std::unique_ptr<CommonEnvironmentSetup>(new CommonEnvironmentSetup(
      platform, errors,
      [&](const CommonEnvironmentSetup* setup) -> Environment* {
        return CreateEnvironment(
            setup->isolate_data(), setup->context(),
            std::forward<EnvironmentArgs>(env_args)...);
      }));
  if (!errors->empty()) ret.reset();
  return ret;
}

// Implementation for ::CreateFromSnapshot -- the ::Create() method
// could call this with a nullptr snapshot_data in a major version.
template <typename... EnvironmentArgs>
std::unique_ptr<CommonEnvironmentSetup>
CommonEnvironmentSetup::CreateFromSnapshot(
    MultiIsolatePlatform* platform,
    std::vector<std::string>* errors,
    const EmbedderSnapshotData* snapshot_data,
    EnvironmentArgs&&... env_args) {
  auto ret = std::unique_ptr<CommonEnvironmentSetup>(new CommonEnvironmentSetup(
      platform,
      errors,
      snapshot_data,
      Flags::kNoFlags,
      [&](const CommonEnvironmentSetup* setup) -> Environment* {
        return CreateEnvironment(setup->isolate_data(),
                                 setup->context(),
                                 std::forward<EnvironmentArgs>(env_args)...);
      }));
  if (!errors->empty()) ret.reset();
  return ret;
}

/* Converts a unixtime to V8 Date */
NODE_DEPRECATED("Use v8::Date::New() directly",
                inline v8::Local<v8::Value> NODE_UNIXTIME_V8(double time) {
                  return v8::Date::New(
                             v8::Isolate::GetCurrent()->GetCurrentContext(),
                             1000 * time)
                      .ToLocalChecked();
                })
#define NODE_UNIXTIME_V8 node::NODE_UNIXTIME_V8
NODE_DEPRECATED("Use v8::Date::ValueOf() directly",
                inline double NODE_V8_UNIXTIME(v8::Local<v8::Date> date) {
  return date->ValueOf() / 1000;
})
#define NODE_V8_UNIXTIME node::NODE_V8_UNIXTIME

#define NODE_DEFINE_CONSTANT(target, constant)                                 \
  do {                                                                         \
    v8::Isolate* isolate = target->GetIsolate();                               \
    v8::Local<v8::Context> context = isolate->GetCurrentContext();             \
    v8::Local<v8::String> constant_name = v8::String::NewFromUtf8Literal(      \
        isolate, #constant, v8::NewStringType::kInternalized);                 \
    v8::Local<v8::Number> constant_value =                                     \
        v8::Number::New(isolate, static_cast<double>(constant));               \
    v8::PropertyAttribute constant_attributes =                                \
        static_cast<v8::PropertyAttribute>(v8::ReadOnly | v8::DontDelete);     \
    (target)                                                                   \
        ->DefineOwnProperty(                                                   \
            context, constant_name, constant_value, constant_attributes)       \
        .Check();                                                              \
  } while (0)

#define NODE_DEFINE_HIDDEN_CONSTANT(target, constant)                          \
  do {                                                                         \
    v8::Isolate* isolate = target->GetIsolate();                               \
    v8::Local<v8::Context> context = isolate->GetCurrentContext();             \
    v8::Local<v8::String> constant_name = v8::String::NewFromUtf8Literal(      \
        isolate, #constant, v8::NewStringType::kInternalized);                 \
    v8::Local<v8::Number> constant_value =                                     \
        v8::Number::New(isolate, static_cast<double>(constant));               \
    v8::PropertyAttribute constant_attributes =                                \
        static_cast<v8::PropertyAttribute>(v8::ReadOnly | v8::DontDelete |     \
                                           v8::DontEnum);                      \
    (target)                                                                   \
        ->DefineOwnProperty(                                                   \
            context, constant_name, constant_value, constant_attributes)       \
        .Check();                                                              \
  } while (0)

// Used to be a macro, hence the uppercase name.
inline void NODE_SET_METHOD(v8::Local<v8::Template> recv,
                            const char* name,
                            v8::FunctionCallback callback) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  v8::HandleScope handle_scope(isolate);
  v8::Local<v8::FunctionTemplate> t = v8::FunctionTemplate::New(isolate,
                                                                callback);
  v8::Local<v8::String> fn_name = v8::String::NewFromUtf8(isolate, name,
      v8::NewStringType::kInternalized).ToLocalChecked();
  t->SetClassName(fn_name);
  recv->Set(fn_name, t);
}

// Used to be a macro, hence the uppercase name.
inline void NODE_SET_METHOD(v8::Local<v8::Object> recv,
                            const char* name,
                            v8::FunctionCallback callback) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  v8::HandleScope handle_scope(isolate);
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  v8::Local<v8::FunctionTemplate> t = v8::FunctionTemplate::New(isolate,
                                                                callback);
  v8::Local<v8::Function> fn = t->GetFunction(context).ToLocalChecked();
  v8::Local<v8::String> fn_name = v8::String::NewFromUtf8(isolate, name,
      v8::NewStringType::kInternalized).ToLocalChecked();
  fn->SetName(fn_name);
  recv->Set(context, fn_name, fn).Check();
}
#define NODE_SET_METHOD node::NODE_SET_METHOD

// Used to be a macro, hence the uppercase name.
// Not a template because it only makes sense for FunctionTemplates.
inline void NODE_SET_PROTOTYPE_METHOD(v8::Local<v8::FunctionTemplate> recv,
                                      const char* name,
                                      v8::FunctionCallback callback) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  v8::HandleScope handle_scope(isolate);
  v8::Local<v8::Signature> s = v8::Signature::New(isolate, recv);
  v8::Local<v8::FunctionTemplate> t =
      v8::FunctionTemplate::New(isolate, callback, v8::Local<v8::Value>(), s);
  v8::Local<v8::String> fn_name = v8::String::NewFromUtf8(isolate, name,
      v8::NewStringType::kInternalized).ToLocalChecked();
  t->SetClassName(fn_name);
  recv->PrototypeTemplate()->Set(fn_name, t);
}
#define NODE_SET_PROTOTYPE_METHOD node::NODE_SET_PROTOTYPE_METHOD

// BINARY is a deprecated alias of LATIN1.
// BASE64URL is not currently exposed to the JavaScript side.
enum encoding {
  ASCII,
  UTF8,
  BASE64,
  UCS2,
  BINARY,
  HEX,
  BUFFER,
  BASE64URL,
  LATIN1 = BINARY
};

NODE_EXTERN enum encoding ParseEncoding(
    v8::Isolate* isolate,
    v8::Local<v8::Value> encoding_v,
    enum encoding default_encoding = LATIN1);

NODE_EXTERN void FatalException(v8::Isolate* isolate,
                                const v8::TryCatch& try_catch);

NODE_EXTERN v8::Local<v8::Value> Encode(v8::Isolate* isolate,
                                        const char* buf,
                                        size_t len,
                                        enum encoding encoding = LATIN1);

// Warning: This reverses endianness on Big Endian platforms, even though the
// signature using uint16_t implies that it should not.
NODE_EXTERN v8::Local<v8::Value> Encode(v8::Isolate* isolate,
                                        const uint16_t* buf,
                                        size_t len);

// Returns -1 if the handle was not valid for decoding
NODE_EXTERN ssize_t DecodeBytes(v8::Isolate* isolate,
                                v8::Local<v8::Value>,
                                enum encoding encoding = LATIN1);
// returns bytes written.
NODE_EXTERN ssize_t DecodeWrite(v8::Isolate* isolate,
                                char* buf,
                                size_t buflen,
                                v8::Local<v8::Value>,
                                enum encoding encoding = LATIN1);
#ifdef _WIN32
NODE_EXTERN v8::Local<v8::Value> WinapiErrnoException(
    v8::Isolate* isolate,
    int errorno,
    const char* syscall = nullptr,
    const char* msg = "",
    const char* path = nullptr);
#endif

const char* signo_string(int errorno);


typedef void (*addon_register_func)(
    v8::Local<v8::Object> exports,
    v8::Local<v8::Value> module,
    void* priv);

typedef void (*addon_context_register_func)(
    v8::Local<v8::Object> exports,
    v8::Local<v8::Value> module,
    v8::Local<v8::Context> context,
    void* priv);

enum ModuleFlags {
  kLinked = 0x02
};

struct node_module {
  int nm_version;
  unsigned int nm_flags;
  void* nm_dso_handle;
  const char* nm_filename;
  node::addon_register_func nm_register_func;
  node::addon_context_register_func nm_context_register_func;
  const char* nm_modname;
  void* nm_priv;
  struct node_module* nm_link;
};

extern "C" NODE_EXTERN void node_module_register(void* mod);

#ifdef _WIN32
# define NODE_MODULE_EXPORT __declspec(dllexport)
#else
# define NODE_MODULE_EXPORT __attribute__((visibility("default")))
#endif

#ifdef NODE_SHARED_MODE
# define NODE_CTOR_PREFIX
#else
# define NODE_CTOR_PREFIX static
#endif

#if defined(_MSC_VER)
#define NODE_C_CTOR(fn)                                               \
  NODE_CTOR_PREFIX void __cdecl fn(void);                             \
  namespace {                                                         \
  struct fn##_ {                                                      \
    fn##_() { fn(); };                                                \
  } fn##_v_;                                                          \
  }                                                                   \
  NODE_CTOR_PREFIX void __cdecl fn(void)
#else
#define NODE_C_CTOR(fn)                                               \
  NODE_CTOR_PREFIX void fn(void) __attribute__((constructor));        \
  NODE_CTOR_PREFIX void fn(void)
#endif

#define NODE_MODULE_X(modname, regfunc, priv, flags)                  \
  extern "C" {                                                        \
    static node::node_module _module =                                \
    {                                                                 \
      NODE_MODULE_VERSION,                                            \
      flags,                                                          \
      NULL,  /* NOLINT (readability/null_usage) */                    \
      __FILE__,                                                       \
      (node::addon_register_func) (regfunc),                          \
      NULL,  /* NOLINT (readability/null_usage) */                    \
      NODE_STRINGIFY(modname),                                        \
      priv,                                                           \
      NULL   /* NOLINT (readability/null_usage) */                    \
    };                                                                \
    NODE_C_CTOR(_register_ ## modname) {                              \
      node_module_register(&_module);                                 \
    }                                                                 \
  }

#define NODE_MODULE_CONTEXT_AWARE_X(modname, regfunc, priv, flags)    \
  extern "C" {                                                        \
    static node::node_module _module =                                \
    {                                                                 \
      NODE_MODULE_VERSION,                                            \
      flags,                                                          \
      NULL,  /* NOLINT (readability/null_usage) */                    \
      __FILE__,                                                       \
      NULL,  /* NOLINT (readability/null_usage) */                    \
      (node::addon_context_register_func) (regfunc),                  \
      NODE_STRINGIFY(modname),                                        \
      priv,                                                           \
      NULL  /* NOLINT (readability/null_usage) */                     \
    };                                                                \
    NODE_C_CTOR(_register_ ## modname) {                              \
      node_module_register(&_module);                                 \
    }                                                                 \
  }

// Usage: `NODE_MODULE(NODE_GYP_MODULE_NAME, InitializerFunction)`
// If no NODE_MODULE is declared, Node.js looks for the well-known
// symbol `node_register_module_v${NODE_MODULE_VERSION}`.
#define NODE_MODULE(modname, regfunc)                                 \
  NODE_MODULE_X(modname, regfunc, NULL, 0)  // NOLINT (readability/null_usage)

#define NODE_MODULE_CONTEXT_AWARE(modname, regfunc)                   \
  /* NOLINTNEXTLINE (readability/null_usage) */                       \
  NODE_MODULE_CONTEXT_AWARE_X(modname, regfunc, NULL, 0)

// Embedders can use this type of binding for statically linked native bindings.
// It is used the same way addon bindings are used, except that linked bindings
// can be accessed through `process._linkedBinding(modname)`.
#define NODE_MODULE_LINKED(modname, regfunc)                               \
  /* NOLINTNEXTLINE (readability/null_usage) */                            \
  NODE_MODULE_CONTEXT_AWARE_X(modname, regfunc, NULL,                      \
                              node::ModuleFlags::kLinked)

/*
 * For backward compatibility in add-on modules.
 */
#define NODE_MODULE_DECL /* nothing */

#define NODE_MODULE_INITIALIZER_BASE node_register_module_v

#define NODE_MODULE_INITIALIZER_X(base, version)                      \
    NODE_MODULE_INITIALIZER_X_HELPER(base, version)

#define NODE_MODULE_INITIALIZER_X_HELPER(base, version) base##version

#define NODE_MODULE_INITIALIZER                                       \
  NODE_MODULE_INITIALIZER_X(NODE_MODULE_INITIALIZER_BASE,             \
      NODE_MODULE_VERSION)

#define NODE_MODULE_INIT()                                            \
  extern "C" NODE_MODULE_EXPORT void                                  \
  NODE_MODULE_INITIALIZER(v8::Local<v8::Object> exports,              \
                          v8::Local<v8::Value> module,                \
                          v8::Local<v8::Context> context);            \
  NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME,                     \
                            NODE_MODULE_INITIALIZER)                  \
  void NODE_MODULE_INITIALIZER(v8::Local<v8::Object> exports,         \
                               v8::Local<v8::Value> module,           \
                               v8::Local<v8::Context> context)

// Allows embedders to add a binding to the current Environment* that can be
// accessed through process._linkedBinding() in the target Environment and all
// Worker threads that it creates.
// In each variant, the registration function needs to be usable at least for
// the time during which the Environment exists.
NODE_EXTERN void AddLinkedBinding(Environment* env, const node_module& mod);
NODE_EXTERN void AddLinkedBinding(Environment* env,
                                  const struct napi_module& mod);
NODE_EXTERN void AddLinkedBinding(Environment* env,
                                  const char* name,
                                  addon_context_register_func fn,
                                  void* priv);
NODE_EXTERN void AddLinkedBinding(
    Environment* env,
    const char* name,
    napi_addon_register_func fn,
    int32_t module_api_version = NODE_API_DEFAULT_MODULE_API_VERSION);

/* Registers a callback with the passed-in Environment instance. The callback
 * is called after the event loop exits, but before the VM is disposed.
 * Callbacks are run in reverse order of registration, i.e. newest first.
 */
NODE_EXTERN void AtExit(Environment* env,
                        void (*cb)(void* arg),
                        void* arg);

typedef double async_id;
struct async_context {
  ::node::async_id async_id;
  ::node::async_id trigger_async_id;
};

/* This is a lot like node::AtExit, except that the hooks added via this
 * function are run before the AtExit ones and will always be registered
 * for the current Environment instance.
 * These functions are safe to use in an addon supporting multiple
 * threads/isolates. */
NODE_EXTERN void AddEnvironmentCleanupHook(v8::Isolate* isolate,
                                           void (*fun)(void* arg),
                                           void* arg);

NODE_EXTERN void RemoveEnvironmentCleanupHook(v8::Isolate* isolate,
                                              void (*fun)(void* arg),
                                              void* arg);

/* These are async equivalents of the above. After the cleanup hook is invoked,
 * `cb(cbarg)` *must* be called, and attempting to remove the cleanup hook will
 * have no effect. */
struct ACHHandle;
struct NODE_EXTERN DeleteACHHandle { void operator()(ACHHandle*) const; };
typedef std::unique_ptr<ACHHandle, DeleteACHHandle> AsyncCleanupHookHandle;

/* This function is not intended to be used externally, it exists to aid in
 * keeping ABI compatibility between Node and Electron. */
NODE_EXTERN ACHHandle* AddEnvironmentCleanupHookInternal(
    v8::Isolate* isolate,
    void (*fun)(void* arg, void (*cb)(void*), void* cbarg),
    void* arg);
inline AsyncCleanupHookHandle AddEnvironmentCleanupHook(
    v8::Isolate* isolate,
    void (*fun)(void* arg, void (*cb)(void*), void* cbarg),
    void* arg) {
  return AsyncCleanupHookHandle(AddEnvironmentCleanupHookInternal(isolate, fun,
      arg));
}

/* This function is not intended to be used externally, it exists to aid in
 * keeping ABI compatibility between Node and Electron. */
NODE_EXTERN void RemoveEnvironmentCleanupHookInternal(ACHHandle* holder);
inline void RemoveEnvironmentCleanupHook(AsyncCleanupHookHandle holder) {
  RemoveEnvironmentCleanupHookInternal(holder.get());
}

// This behaves like V8's Isolate::RequestInterrupt(), but also wakes up
// the event loop if it is currently idle. Interrupt requests are drained
// in `FreeEnvironment()`. The passed callback can not call back into
// JavaScript.
// This function can be called from any thread.
NODE_EXTERN void RequestInterrupt(Environment* env,
                                  void (*fun)(void* arg),
                                  void* arg);

/* Returns the id of the current execution context. If the return value is
 * zero then no execution has been set. This will happen if the user handles
 * I/O from native code. */
NODE_EXTERN async_id AsyncHooksGetExecutionAsyncId(v8::Isolate* isolate);

/* Returns the id of the current execution context. If the return value is
 * zero then no execution has been set. This will happen if the user handles
 * I/O from native code. */
NODE_EXTERN async_id
AsyncHooksGetExecutionAsyncId(v8::Local<v8::Context> context);

/* Return same value as async_hooks.triggerAsyncId(); */
NODE_EXTERN async_id AsyncHooksGetTriggerAsyncId(v8::Isolate* isolate);

/* If the native API doesn't inherit from the helper class then the callbacks
 * must be triggered manually. This triggers the init() callback. The return
 * value is the async id assigned to the resource.
 *
 * The `trigger_async_id` parameter should correspond to the resource which is
 * creating the new resource, which will usually be the return value of
 * `AsyncHooksGetTriggerAsyncId()`. */
NODE_EXTERN async_context EmitAsyncInit(v8::Isolate* isolate,
                                        v8::Local<v8::Object> resource,
                                        const char* name,
                                        async_id trigger_async_id = -1);

NODE_EXTERN async_context EmitAsyncInit(v8::Isolate* isolate,
                                        v8::Local<v8::Object> resource,
                                        v8::Local<v8::String> name,
                                        async_id trigger_async_id = -1);

/* Emit the destroy() callback. The overload taking an `Environment*` argument
 * should be used when the Isolate’s current Context is not associated with
 * a Node.js Environment, or when there is no current Context, for example
 * when calling this function during garbage collection. In that case, the
 * `Environment*` value should have been acquired previously, e.g. through
 * `GetCurrentEnvironment()`. */
NODE_EXTERN void EmitAsyncDestroy(v8::Isolate* isolate,
                                  async_context asyncContext);
NODE_EXTERN void EmitAsyncDestroy(Environment* env,
                                  async_context asyncContext);

class InternalCallbackScope;

/* This class works like `MakeCallback()` in that it sets up a specific
 * asyncContext as the current one and informs the async_hooks and domains
 * modules that this context is currently active.
 *
 * `MakeCallback()` is a wrapper around this class as well as
 * `Function::Call()`. Either one of these mechanisms needs to be used for
 * top-level calls into JavaScript (i.e. without any existing JS stack).
 *
 * This object should be stack-allocated to ensure that it is contained in a
 * valid HandleScope.
 *
 * Exceptions happening within this scope will be treated like uncaught
 * exceptions. If this behaviour is undesirable, a new `v8::TryCatch` scope
 * needs to be created inside of this scope.
 */
class NODE_EXTERN CallbackScope {
 public:
  CallbackScope(v8::Isolate* isolate,
                v8::Local<v8::Object> resource,
                async_context asyncContext);
  CallbackScope(Environment* env,
                v8::Local<v8::Object> resource,
                async_context asyncContext);
  ~CallbackScope();

  void operator=(const CallbackScope&) = delete;
  void operator=(CallbackScope&&) = delete;
  CallbackScope(const CallbackScope&) = delete;
  CallbackScope(CallbackScope&&) = delete;

 private:
  InternalCallbackScope* private_;
  v8::TryCatch try_catch_;
};

/* An API specific to emit before/after callbacks is unnecessary because
 * MakeCallback will automatically call them for you.
 *
 * These methods may create handles on their own, so run them inside a
 * HandleScope.
 *
 * `asyncId` and `triggerAsyncId` should correspond to the values returned by
 * `EmitAsyncInit()` and `AsyncHooksGetTriggerAsyncId()`, respectively, when the
 * invoking resource was created. If these values are unknown, 0 can be passed.
 * */
NODE_EXTERN
v8::MaybeLocal<v8::Value> MakeCallback(v8::Isolate* isolate,
                                       v8::Local<v8::Object> recv,
                                       v8::Local<v8::Function> callback,
                                       int argc,
                                       v8::Local<v8::Value>* argv,
                                       async_context asyncContext);
NODE_EXTERN
v8::MaybeLocal<v8::Value> MakeCallback(v8::Isolate* isolate,
                                       v8::Local<v8::Object> recv,
                                       const char* method,
                                       int argc,
                                       v8::Local<v8::Value>* argv,
                                       async_context asyncContext);
NODE_EXTERN
v8::MaybeLocal<v8::Value> MakeCallback(v8::Isolate* isolate,
                                       v8::Local<v8::Object> recv,
                                       v8::Local<v8::String> symbol,
                                       int argc,
                                       v8::Local<v8::Value>* argv,
                                       async_context asyncContext);

/* Helper class users can optionally inherit from. If
 * `AsyncResource::MakeCallback()` is used, then all four callbacks will be
 * called automatically. */
class NODE_EXTERN AsyncResource {
 public:
  AsyncResource(v8::Isolate* isolate,
                v8::Local<v8::Object> resource,
                const char* name,
                async_id trigger_async_id = -1);

  virtual ~AsyncResource();

  AsyncResource(const AsyncResource&) = delete;
  void operator=(const AsyncResource&) = delete;

  v8::MaybeLocal<v8::Value> MakeCallback(
      v8::Local<v8::Function> callback,
      int argc,
      v8::Local<v8::Value>* argv);

  v8::MaybeLocal<v8::Value> MakeCallback(
      const char* method,
      int argc,
      v8::Local<v8::Value>* argv);

  v8::MaybeLocal<v8::Value> MakeCallback(
      v8::Local<v8::String> symbol,
      int argc,
      v8::Local<v8::Value>* argv);

  v8::Local<v8::Object> get_resource();
  async_id get_async_id() const;
  async_id get_trigger_async_id() const;

 protected:
  class NODE_EXTERN CallbackScope : public node::CallbackScope {
   public:
    explicit CallbackScope(AsyncResource* res);
  };

 private:
  Environment* env_;
  v8::Global<v8::Object> resource_;
  async_context async_context_;
};

#ifndef _WIN32
// Register a signal handler without interrupting any handlers that node
// itself needs. This does override handlers registered through
// process.on('SIG...', function() { ... }). The `reset_handler` flag indicates
// whether the signal handler for the given signal should be reset to its
// default value before executing the handler (i.e. it works like SA_RESETHAND).
// The `reset_handler` flag is invalid when `signal` is SIGSEGV.
NODE_EXTERN
void RegisterSignalHandler(int signal,
                           void (*handler)(int signal,
                                           siginfo_t* info,
                                           void* ucontext),
                           bool reset_handler = false);
#endif  // _WIN32

// Configure the layout of the JavaScript object with a cppgc::GarbageCollected
// instance so that when the JavaScript object is reachable, the garbage
// collected instance would have its Trace() method invoked per the cppgc
// contract. To make it work, the process must have called
// cppgc::InitializeProcess() before, which is usually the case for addons
// loaded by the stand-alone Node.js executable. Embedders of Node.js can use
// either need to call it themselves or make sure that
// ProcessInitializationFlags::kNoInitializeCppgc is *not* set for cppgc to
// work.
// If the CppHeap is owned by Node.js, which is usually the case for addon,
// the object must be created with at least two internal fields available,
// and the first two internal fields would be configured by Node.js.
// This may be superseded by a V8 API in the future, see
// https://bugs.chromium.org/p/v8/issues/detail?id=13960. Until then this
// serves as a helper for Node.js isolates.
NODE_EXTERN void SetCppgcReference(v8::Isolate* isolate,
                                   v8::Local<v8::Object> object,
                                   void* wrappable);

}  // namespace node

#endif  // SRC_NODE_H_
