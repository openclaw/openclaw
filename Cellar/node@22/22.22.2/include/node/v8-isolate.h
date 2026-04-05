// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_ISOLATE_H_
#define INCLUDE_V8_ISOLATE_H_

#include <stddef.h>
#include <stdint.h>

#include <memory>
#include <string>
#include <utility>

#include "cppgc/common.h"
#include "v8-array-buffer.h"       // NOLINT(build/include_directory)
#include "v8-callbacks.h"          // NOLINT(build/include_directory)
#include "v8-data.h"               // NOLINT(build/include_directory)
#include "v8-debug.h"              // NOLINT(build/include_directory)
#include "v8-embedder-heap.h"      // NOLINT(build/include_directory)
#include "v8-function-callback.h"  // NOLINT(build/include_directory)
#include "v8-internal.h"           // NOLINT(build/include_directory)
#include "v8-local-handle.h"       // NOLINT(build/include_directory)
#include "v8-microtask.h"          // NOLINT(build/include_directory)
#include "v8-persistent-handle.h"  // NOLINT(build/include_directory)
#include "v8-primitive.h"          // NOLINT(build/include_directory)
#include "v8-statistics.h"         // NOLINT(build/include_directory)
#include "v8-unwinder.h"           // NOLINT(build/include_directory)
#include "v8config.h"              // NOLINT(build/include_directory)

namespace v8 {

class CppHeap;
class HeapProfiler;
class MicrotaskQueue;
class StartupData;
class ScriptOrModule;
class SharedArrayBuffer;

namespace internal {
class MicrotaskQueue;
class ThreadLocalTop;
}  // namespace internal

namespace metrics {
class Recorder;
}  // namespace metrics

/**
 * A set of constraints that specifies the limits of the runtime's memory use.
 * You must set the heap size before initializing the VM - the size cannot be
 * adjusted after the VM is initialized.
 *
 * If you are using threads then you should hold the V8::Locker lock while
 * setting the stack limit and you must set a non-default stack limit separately
 * for each thread.
 *
 * The arguments for set_max_semi_space_size, set_max_old_space_size,
 * set_max_executable_size, set_code_range_size specify limits in MB.
 *
 * The argument for set_max_semi_space_size_in_kb is in KB.
 */
class V8_EXPORT ResourceConstraints {
 public:
  /**
   * Configures the constraints with reasonable default values based on the
   * provided heap size limit. The heap size includes both the young and
   * the old generation.
   *
   * \param initial_heap_size_in_bytes The initial heap size or zero.
   *    By default V8 starts with a small heap and dynamically grows it to
   *    match the set of live objects. This may lead to ineffective
   *    garbage collections at startup if the live set is large.
   *    Setting the initial heap size avoids such garbage collections.
   *    Note that this does not affect young generation garbage collections.
   *
   * \param maximum_heap_size_in_bytes The hard limit for the heap size.
   *    When the heap size approaches this limit, V8 will perform series of
   *    garbage collections and invoke the NearHeapLimitCallback. If the garbage
   *    collections do not help and the callback does not increase the limit,
   *    then V8 will crash with V8::FatalProcessOutOfMemory.
   */
  void ConfigureDefaultsFromHeapSize(size_t initial_heap_size_in_bytes,
                                     size_t maximum_heap_size_in_bytes);

  /**
   * Configures the constraints with reasonable default values based on the
   * capabilities of the current device the VM is running on.
   *
   * \param physical_memory The total amount of physical memory on the current
   *   device, in bytes.
   * \param virtual_memory_limit The amount of virtual memory on the current
   *   device, in bytes, or zero, if there is no limit.
   */
  void ConfigureDefaults(uint64_t physical_memory,
                         uint64_t virtual_memory_limit);

  /**
   * The address beyond which the VM's stack may not grow.
   */
  uint32_t* stack_limit() const { return stack_limit_; }
  void set_stack_limit(uint32_t* value) { stack_limit_ = value; }

  /**
   * The amount of virtual memory reserved for generated code. This is relevant
   * for 64-bit architectures that rely on code range for calls in code.
   *
   * When V8_COMPRESS_POINTERS_IN_SHARED_CAGE is defined, there is a shared
   * process-wide code range that is lazily initialized. This value is used to
   * configure that shared code range when the first Isolate is
   * created. Subsequent Isolates ignore this value.
   */
  size_t code_range_size_in_bytes() const { return code_range_size_; }
  void set_code_range_size_in_bytes(size_t limit) { code_range_size_ = limit; }

  /**
   * The maximum size of the old generation.
   * When the old generation approaches this limit, V8 will perform series of
   * garbage collections and invoke the NearHeapLimitCallback.
   * If the garbage collections do not help and the callback does not
   * increase the limit, then V8 will crash with V8::FatalProcessOutOfMemory.
   */
  size_t max_old_generation_size_in_bytes() const {
    return max_old_generation_size_;
  }
  void set_max_old_generation_size_in_bytes(size_t limit) {
    max_old_generation_size_ = limit;
  }

  /**
   * The maximum size of the young generation, which consists of two semi-spaces
   * and a large object space. This affects frequency of Scavenge garbage
   * collections and should be typically much smaller that the old generation.
   */
  size_t max_young_generation_size_in_bytes() const {
    return max_young_generation_size_;
  }
  void set_max_young_generation_size_in_bytes(size_t limit) {
    max_young_generation_size_ = limit;
  }

  size_t initial_old_generation_size_in_bytes() const {
    return initial_old_generation_size_;
  }
  void set_initial_old_generation_size_in_bytes(size_t initial_size) {
    initial_old_generation_size_ = initial_size;
  }

  size_t initial_young_generation_size_in_bytes() const {
    return initial_young_generation_size_;
  }
  void set_initial_young_generation_size_in_bytes(size_t initial_size) {
    initial_young_generation_size_ = initial_size;
  }

 private:
  static constexpr size_t kMB = 1048576u;
  size_t code_range_size_ = 0;
  size_t max_old_generation_size_ = 0;
  size_t max_young_generation_size_ = 0;
  size_t initial_old_generation_size_ = 0;
  size_t initial_young_generation_size_ = 0;
  uint32_t* stack_limit_ = nullptr;
};

/**
 * Option flags passed to the SetRAILMode function.
 * See documentation https://developers.google.com/web/tools/chrome-devtools/
 * profile/evaluate-performance/rail
 */
enum RAILMode : unsigned {
  // Response performance mode: In this mode very low virtual machine latency
  // is provided. V8 will try to avoid JavaScript execution interruptions.
  // Throughput may be throttled.
  PERFORMANCE_RESPONSE,
  // Animation performance mode: In this mode low virtual machine latency is
  // provided. V8 will try to avoid as many JavaScript execution interruptions
  // as possible. Throughput may be throttled. This is the default mode.
  PERFORMANCE_ANIMATION,
  // Idle performance mode: The embedder is idle. V8 can complete deferred work
  // in this mode.
  PERFORMANCE_IDLE,
  // Load performance mode: In this mode high throughput is provided. V8 may
  // turn off latency optimizations.
  PERFORMANCE_LOAD
};

/**
 * Memory pressure level for the MemoryPressureNotification.
 * kNone hints V8 that there is no memory pressure.
 * kModerate hints V8 to speed up incremental garbage collection at the cost of
 * of higher latency due to garbage collection pauses.
 * kCritical hints V8 to free memory as soon as possible. Garbage collection
 * pauses at this level will be large.
 */
enum class MemoryPressureLevel { kNone, kModerate, kCritical };

/**
 * Indicator for the stack state.
 */
using StackState = cppgc::EmbedderStackState;

/**
 * Isolate represents an isolated instance of the V8 engine.  V8 isolates have
 * completely separate states.  Objects from one isolate must not be used in
 * other isolates.  The embedder can create multiple isolates and use them in
 * parallel in multiple threads.  An isolate can be entered by at most one
 * thread at any given time.  The Locker/Unlocker API must be used to
 * synchronize.
 */
class V8_EXPORT Isolate {
 public:
  /**
   * Initial configuration parameters for a new Isolate.
   */
  struct V8_EXPORT CreateParams {
    CreateParams();
    ~CreateParams();

    ALLOW_COPY_AND_MOVE_WITH_DEPRECATED_FIELDS(CreateParams)

    /**
     * Allows the host application to provide the address of a function that is
     * notified each time code is added, moved or removed.
     */
    JitCodeEventHandler code_event_handler = nullptr;

    /**
     * ResourceConstraints to use for the new Isolate.
     */
    ResourceConstraints constraints;

    /**
     * Explicitly specify a startup snapshot blob. The embedder owns the blob.
     * The embedder *must* ensure that the snapshot is from a trusted source.
     */
    const StartupData* snapshot_blob = nullptr;

    /**
     * Enables the host application to provide a mechanism for recording
     * statistics counters.
     */
    CounterLookupCallback counter_lookup_callback = nullptr;

    /**
     * Enables the host application to provide a mechanism for recording
     * histograms. The CreateHistogram function returns a
     * histogram which will later be passed to the AddHistogramSample
     * function.
     */
    CreateHistogramCallback create_histogram_callback = nullptr;
    AddHistogramSampleCallback add_histogram_sample_callback = nullptr;

    /**
     * The ArrayBuffer::Allocator to use for allocating and freeing the backing
     * store of ArrayBuffers.
     *
     * If the shared_ptr version is used, the Isolate instance and every
     * |BackingStore| allocated using this allocator hold a std::shared_ptr
     * to the allocator, in order to facilitate lifetime
     * management for the allocator instance.
     */
    ArrayBuffer::Allocator* array_buffer_allocator = nullptr;
    std::shared_ptr<ArrayBuffer::Allocator> array_buffer_allocator_shared;

    /**
     * Specifies an optional nullptr-terminated array of raw addresses in the
     * embedder that V8 can match against during serialization and use for
     * deserialization. This array and its content must stay valid for the
     * entire lifetime of the isolate.
     */
    const intptr_t* external_references = nullptr;

    /**
     * Whether calling Atomics.wait (a function that may block) is allowed in
     * this isolate. This can also be configured via SetAllowAtomicsWait.
     */
    bool allow_atomics_wait = true;

    /**
     * Termination is postponed when there is no active SafeForTerminationScope.
     */
    bool only_terminate_in_safe_scope = false;

    /**
     * The following parameters describe the offsets for addressing type info
     * for wrapped API objects and are used by the fast C API
     * (for details see v8-fast-api-calls.h).
     */
    int embedder_wrapper_type_index = -1;
    int embedder_wrapper_object_index = -1;

    /**
     * Callbacks to invoke in case of fatal or OOM errors.
     */
    FatalErrorCallback fatal_error_callback = nullptr;
    OOMErrorCallback oom_error_callback = nullptr;

    /**
     * A CppHeap used to construct the Isolate. V8 takes ownership of the
     * CppHeap passed this way.
     */
    CppHeap* cpp_heap = nullptr;
  };

  /**
   * Stack-allocated class which sets the isolate for all operations
   * executed within a local scope.
   */
  class V8_EXPORT V8_NODISCARD Scope {
   public:
    explicit Scope(Isolate* isolate) : v8_isolate_(isolate) {
      v8_isolate_->Enter();
    }

    ~Scope() { v8_isolate_->Exit(); }

    // Prevent copying of Scope objects.
    Scope(const Scope&) = delete;
    Scope& operator=(const Scope&) = delete;

   private:
    Isolate* const v8_isolate_;
  };

  /**
   * Assert that no Javascript code is invoked.
   */
  class V8_EXPORT V8_NODISCARD DisallowJavascriptExecutionScope {
   public:
    enum OnFailure { CRASH_ON_FAILURE, THROW_ON_FAILURE, DUMP_ON_FAILURE };

    DisallowJavascriptExecutionScope(Isolate* isolate, OnFailure on_failure);
    ~DisallowJavascriptExecutionScope();

    // Prevent copying of Scope objects.
    DisallowJavascriptExecutionScope(const DisallowJavascriptExecutionScope&) =
        delete;
    DisallowJavascriptExecutionScope& operator=(
        const DisallowJavascriptExecutionScope&) = delete;

   private:
    v8::Isolate* const v8_isolate_;
    const OnFailure on_failure_;
    bool was_execution_allowed_;
  };

  /**
   * Introduce exception to DisallowJavascriptExecutionScope.
   */
  class V8_EXPORT V8_NODISCARD AllowJavascriptExecutionScope {
   public:
    explicit AllowJavascriptExecutionScope(Isolate* isolate);
    ~AllowJavascriptExecutionScope();

    // Prevent copying of Scope objects.
    AllowJavascriptExecutionScope(const AllowJavascriptExecutionScope&) =
        delete;
    AllowJavascriptExecutionScope& operator=(
        const AllowJavascriptExecutionScope&) = delete;

   private:
    Isolate* const v8_isolate_;
    bool was_execution_allowed_assert_;
    bool was_execution_allowed_throws_;
    bool was_execution_allowed_dump_;
  };

  /**
   * Do not run microtasks while this scope is active, even if microtasks are
   * automatically executed otherwise.
   */
  class V8_EXPORT V8_NODISCARD SuppressMicrotaskExecutionScope {
   public:
    explicit SuppressMicrotaskExecutionScope(
        Isolate* isolate, MicrotaskQueue* microtask_queue = nullptr);
    ~SuppressMicrotaskExecutionScope();

    // Prevent copying of Scope objects.
    SuppressMicrotaskExecutionScope(const SuppressMicrotaskExecutionScope&) =
        delete;
    SuppressMicrotaskExecutionScope& operator=(
        const SuppressMicrotaskExecutionScope&) = delete;

   private:
    internal::Isolate* const i_isolate_;
    internal::MicrotaskQueue* const microtask_queue_;
    internal::Address previous_stack_height_;

    friend class internal::ThreadLocalTop;
  };

  /**
   * This scope allows terminations inside direct V8 API calls and forbid them
   * inside any recursive API calls without explicit SafeForTerminationScope.
   */
  class V8_EXPORT V8_NODISCARD SafeForTerminationScope {
   public:
    V8_DEPRECATE_SOON("All code should be safe for termination")
    explicit SafeForTerminationScope(v8::Isolate* v8_isolate) {}
    ~SafeForTerminationScope() {}

    // Prevent copying of Scope objects.
    SafeForTerminationScope(const SafeForTerminationScope&) = delete;
    SafeForTerminationScope& operator=(const SafeForTerminationScope&) = delete;
  };

  /**
   * Types of garbage collections that can be requested via
   * RequestGarbageCollectionForTesting.
   */
  enum GarbageCollectionType {
    kFullGarbageCollection,
    kMinorGarbageCollection
  };

  /**
   * Features reported via the SetUseCounterCallback callback. Do not change
   * assigned numbers of existing items; add new features to the end of this
   * list.
   * Dead features can be marked `V8_DEPRECATE_SOON`, then `V8_DEPRECATED`, and
   * then finally be renamed to `kOBSOLETE_...` to stop embedders from using
   * them.
   */
  enum UseCounterFeature {
    kUseAsm = 0,
    kBreakIterator = 1,
    kOBSOLETE_LegacyConst = 2,
    kOBSOLETE_MarkDequeOverflow = 3,
    kOBSOLETE_StoreBufferOverflow = 4,
    kOBSOLETE_SlotsBufferOverflow = 5,
    kOBSOLETE_ObjectObserve = 6,
    kForcedGC = 7,
    kSloppyMode = 8,
    kStrictMode = 9,
    kOBSOLETE_StrongMode = 10,
    kRegExpPrototypeStickyGetter = 11,
    kRegExpPrototypeToString = 12,
    kRegExpPrototypeUnicodeGetter = 13,
    kOBSOLETE_IntlV8Parse = 14,
    kOBSOLETE_IntlPattern = 15,
    kOBSOLETE_IntlResolved = 16,
    kOBSOLETE_PromiseChain = 17,
    kOBSOLETE_PromiseAccept = 18,
    kOBSOLETE_PromiseDefer = 19,
    kHtmlCommentInExternalScript = 20,
    kHtmlComment = 21,
    kSloppyModeBlockScopedFunctionRedefinition = 22,
    kForInInitializer = 23,
    kOBSOLETE_ArrayProtectorDirtied = 24,
    kArraySpeciesModified = 25,
    kArrayPrototypeConstructorModified = 26,
    kOBSOLETE_ArrayInstanceProtoModified = 27,
    kArrayInstanceConstructorModified = 28,
    kOBSOLETE_LegacyFunctionDeclaration = 29,
    kOBSOLETE_RegExpPrototypeSourceGetter = 30,
    kOBSOLETE_RegExpPrototypeOldFlagGetter = 31,
    kDecimalWithLeadingZeroInStrictMode = 32,
    kLegacyDateParser = 33,
    kDefineGetterOrSetterWouldThrow = 34,
    kFunctionConstructorReturnedUndefined = 35,
    kAssigmentExpressionLHSIsCallInSloppy = 36,
    kAssigmentExpressionLHSIsCallInStrict = 37,
    kPromiseConstructorReturnedUndefined = 38,
    kOBSOLETE_ConstructorNonUndefinedPrimitiveReturn = 39,
    kOBSOLETE_LabeledExpressionStatement = 40,
    kOBSOLETE_LineOrParagraphSeparatorAsLineTerminator = 41,
    kIndexAccessor = 42,
    kErrorCaptureStackTrace = 43,
    kErrorPrepareStackTrace = 44,
    kErrorStackTraceLimit = 45,
    kWebAssemblyInstantiation = 46,
    kDeoptimizerDisableSpeculation = 47,
    kOBSOLETE_ArrayPrototypeSortJSArrayModifiedPrototype = 48,
    kFunctionTokenOffsetTooLongForToString = 49,
    kWasmSharedMemory = 50,
    kWasmThreadOpcodes = 51,
    kOBSOLETE_AtomicsNotify = 52,
    kOBSOLETE_AtomicsWake = 53,
    kCollator = 54,
    kNumberFormat = 55,
    kDateTimeFormat = 56,
    kPluralRules = 57,
    kRelativeTimeFormat = 58,
    kLocale = 59,
    kListFormat = 60,
    kSegmenter = 61,
    kStringLocaleCompare = 62,
    kOBSOLETE_StringToLocaleUpperCase = 63,
    kStringToLocaleLowerCase = 64,
    kNumberToLocaleString = 65,
    kDateToLocaleString = 66,
    kDateToLocaleDateString = 67,
    kDateToLocaleTimeString = 68,
    kAttemptOverrideReadOnlyOnPrototypeSloppy = 69,
    kAttemptOverrideReadOnlyOnPrototypeStrict = 70,
    kOBSOLETE_OptimizedFunctionWithOneShotBytecode = 71,
    kRegExpMatchIsTrueishOnNonJSRegExp = 72,
    kRegExpMatchIsFalseishOnJSRegExp = 73,
    kOBSOLETE_DateGetTimezoneOffset = 74,
    kStringNormalize = 75,
    kCallSiteAPIGetFunctionSloppyCall = 76,
    kCallSiteAPIGetThisSloppyCall = 77,
    kOBSOLETE_RegExpMatchAllWithNonGlobalRegExp = 78,
    kRegExpExecCalledOnSlowRegExp = 79,
    kRegExpReplaceCalledOnSlowRegExp = 80,
    kDisplayNames = 81,
    kSharedArrayBufferConstructed = 82,
    kArrayPrototypeHasElements = 83,
    kObjectPrototypeHasElements = 84,
    kNumberFormatStyleUnit = 85,
    kDateTimeFormatRange = 86,
    kDateTimeFormatDateTimeStyle = 87,
    kBreakIteratorTypeWord = 88,
    kBreakIteratorTypeLine = 89,
    kInvalidatedArrayBufferDetachingProtector = 90,
    kInvalidatedArrayConstructorProtector = 91,
    kInvalidatedArrayIteratorLookupChainProtector = 92,
    kInvalidatedArraySpeciesLookupChainProtector = 93,
    kInvalidatedIsConcatSpreadableLookupChainProtector = 94,
    kInvalidatedMapIteratorLookupChainProtector = 95,
    kInvalidatedNoElementsProtector = 96,
    kInvalidatedPromiseHookProtector = 97,
    kInvalidatedPromiseResolveLookupChainProtector = 98,
    kInvalidatedPromiseSpeciesLookupChainProtector = 99,
    kInvalidatedPromiseThenLookupChainProtector = 100,
    kInvalidatedRegExpSpeciesLookupChainProtector = 101,
    kInvalidatedSetIteratorLookupChainProtector = 102,
    kInvalidatedStringIteratorLookupChainProtector = 103,
    kInvalidatedStringLengthOverflowLookupChainProtector = 104,
    kInvalidatedTypedArraySpeciesLookupChainProtector = 105,
    kWasmSimdOpcodes = 106,
    kVarRedeclaredCatchBinding = 107,
    kWasmRefTypes = 108,
    kOBSOLETE_WasmBulkMemory = 109,
    kOBSOLETE_WasmMultiValue = 110,
    kWasmExceptionHandling = 111,
    kInvalidatedMegaDOMProtector = 112,
    kFunctionPrototypeArguments = 113,
    kFunctionPrototypeCaller = 114,
    kTurboFanOsrCompileStarted = 115,
    kAsyncStackTaggingCreateTaskCall = 116,
    kDurationFormat = 117,
    kInvalidatedNumberStringNotRegexpLikeProtector = 118,
    kOBSOLETE_RegExpUnicodeSetIncompatibilitiesWithUnicodeMode = 119,
    kImportAssertionDeprecatedSyntax = 120,
    kLocaleInfoObsoletedGetters = 121,
    kLocaleInfoFunctions = 122,
    kCompileHintsMagicAll = 123,
    kInvalidatedNoProfilingProtector = 124,
    kWasmMemory64 = 125,
    kWasmMultiMemory = 126,
    kWasmGC = 127,
    kWasmImportedStrings = 128,
    kSourceMappingUrlMagicCommentAtSign = 129,
    kTemporalObject = 130,
    kWasmModuleCompilation = 131,
    kInvalidatedNoUndetectableObjectsProtector = 132,
    kWasmJavaScriptPromiseIntegration = 133,
    kWasmReturnCall = 134,
    kWasmExtendedConst = 135,
    kWasmRelaxedSimd = 136,
    kWasmTypeReflection = 137,
    kWasmExnRef = 138,
    kWasmTypedFuncRef = 139,
    kInvalidatedStringWrapperToPrimitiveProtector = 140,

    // If you add new values here, you'll also need to update Chromium's:
    // web_feature.mojom, use_counter_callback.cc, and enums.xml. V8 changes to
    // this list need to be landed first, then changes on the Chromium side.
    kUseCounterFeatureCount  // This enum value must be last.
  };

  enum MessageErrorLevel {
    kMessageLog = (1 << 0),
    kMessageDebug = (1 << 1),
    kMessageInfo = (1 << 2),
    kMessageError = (1 << 3),
    kMessageWarning = (1 << 4),
    kMessageAll = kMessageLog | kMessageDebug | kMessageInfo | kMessageError |
                  kMessageWarning,
  };

  using UseCounterCallback = void (*)(Isolate* isolate,
                                      UseCounterFeature feature);

  /**
   * Allocates a new isolate but does not initialize it. Does not change the
   * currently entered isolate.
   *
   * Only Isolate::GetData() and Isolate::SetData(), which access the
   * embedder-controlled parts of the isolate, are allowed to be called on the
   * uninitialized isolate. To initialize the isolate, call
   * `Isolate::Initialize()` or initialize a `SnapshotCreator`.
   *
   * When an isolate is no longer used its resources should be freed
   * by calling Dispose().  Using the delete operator is not allowed.
   *
   * V8::Initialize() must have run prior to this.
   */
  static Isolate* Allocate();

  /**
   * Initialize an Isolate previously allocated by Isolate::Allocate().
   */
  static void Initialize(Isolate* isolate, const CreateParams& params);

  /**
   * Creates a new isolate.  Does not change the currently entered
   * isolate.
   *
   * When an isolate is no longer used its resources should be freed
   * by calling Dispose().  Using the delete operator is not allowed.
   *
   * V8::Initialize() must have run prior to this.
   */
  static Isolate* New(const CreateParams& params);

  /**
   * Returns the entered isolate for the current thread or NULL in
   * case there is no current isolate.
   *
   * This method must not be invoked before V8::Initialize() was invoked.
   */
  static Isolate* GetCurrent();

  /**
   * Returns the entered isolate for the current thread or NULL in
   * case there is no current isolate.
   *
   * No checks are performed by this method.
   */
  static Isolate* TryGetCurrent();

  /**
   * Return true if this isolate is currently active.
   **/
  bool IsCurrent() const;

  /**
   * Clears the set of objects held strongly by the heap. This set of
   * objects are originally built when a WeakRef is created or
   * successfully dereferenced.
   *
   * This is invoked automatically after microtasks are run. See
   * MicrotasksPolicy for when microtasks are run.
   *
   * This needs to be manually invoked only if the embedder is manually running
   * microtasks via a custom MicrotaskQueue class's PerformCheckpoint. In that
   * case, it is the embedder's responsibility to make this call at a time which
   * does not interrupt synchronous ECMAScript code execution.
   */
  void ClearKeptObjects();

  /**
   * Custom callback used by embedders to help V8 determine if it should abort
   * when it throws and no internal handler is predicted to catch the
   * exception. If --abort-on-uncaught-exception is used on the command line,
   * then V8 will abort if either:
   * - no custom callback is set.
   * - the custom callback set returns true.
   * Otherwise, the custom callback will not be called and V8 will not abort.
   */
  using AbortOnUncaughtExceptionCallback = bool (*)(Isolate*);
  void SetAbortOnUncaughtExceptionCallback(
      AbortOnUncaughtExceptionCallback callback);

  /**
   * This specifies the callback called by the upcoming dynamic
   * import() language feature to load modules.
   */
  void SetHostImportModuleDynamicallyCallback(
      HostImportModuleDynamicallyCallback callback);

  /**
   * This specifies the callback called by the upcoming import.meta
   * language feature to retrieve host-defined meta data for a module.
   */
  void SetHostInitializeImportMetaObjectCallback(
      HostInitializeImportMetaObjectCallback callback);

  /**
   * This specifies the callback called by the upcoming ShadowRealm
   * construction language feature to retrieve host created globals.
   */
  void SetHostCreateShadowRealmContextCallback(
      HostCreateShadowRealmContextCallback callback);

  /**
   * This specifies the callback called when the stack property of Error
   * is accessed.
   */
  void SetPrepareStackTraceCallback(PrepareStackTraceCallback callback);

#if defined(V8_OS_WIN)
  /**
   * This specifies the callback called when an ETW tracing session starts.
   */
  void SetFilterETWSessionByURLCallback(FilterETWSessionByURLCallback callback);
#endif  // V8_OS_WIN

  /**
   * Optional notification that the system is running low on memory.
   * V8 uses these notifications to guide heuristics.
   * It is allowed to call this function from another thread while
   * the isolate is executing long running JavaScript code.
   */
  void MemoryPressureNotification(MemoryPressureLevel level);

  /**
   * Optional request from the embedder to tune v8 towards energy efficiency
   * rather than speed if `battery_saver_mode_enabled` is true, because the
   * embedder is in battery saver mode. If false, the correct tuning is left
   * to v8 to decide.
   */
  void SetBatterySaverMode(bool battery_saver_mode_enabled);

  /**
   * Drop non-essential caches. Should only be called from testing code.
   * The method can potentially block for a long time and does not necessarily
   * trigger GC.
   */
  void ClearCachesForTesting();

  /**
   * Methods below this point require holding a lock (using Locker) in
   * a multi-threaded environment.
   */

  /**
   * Sets this isolate as the entered one for the current thread.
   * Saves the previously entered one (if any), so that it can be
   * restored when exiting.  Re-entering an isolate is allowed.
   */
  void Enter();

  /**
   * Exits this isolate by restoring the previously entered one in the
   * current thread.  The isolate may still stay the same, if it was
   * entered more than once.
   *
   * Requires: this == Isolate::GetCurrent().
   */
  void Exit();

  /**
   * Disposes the isolate.  The isolate must not be entered by any
   * thread to be disposable.
   */
  void Dispose();

  /**
   * Dumps activated low-level V8 internal stats. This can be used instead
   * of performing a full isolate disposal.
   */
  void DumpAndResetStats();

  /**
   * Discards all V8 thread-specific data for the Isolate. Should be used
   * if a thread is terminating and it has used an Isolate that will outlive
   * the thread -- all thread-specific data for an Isolate is discarded when
   * an Isolate is disposed so this call is pointless if an Isolate is about
   * to be Disposed.
   */
  void DiscardThreadSpecificMetadata();

  /**
   * Associate embedder-specific data with the isolate. |slot| has to be
   * between 0 and GetNumberOfDataSlots() - 1.
   */
  V8_INLINE void SetData(uint32_t slot, void* data);

  /**
   * Retrieve embedder-specific data from the isolate.
   * Returns NULL if SetData has never been called for the given |slot|.
   */
  V8_INLINE void* GetData(uint32_t slot);

  /**
   * Returns the maximum number of available embedder data slots. Valid slots
   * are in the range of 0 - GetNumberOfDataSlots() - 1.
   */
  V8_INLINE static uint32_t GetNumberOfDataSlots();

  /**
   * Return data that was previously attached to the isolate snapshot via
   * SnapshotCreator, and removes the reference to it.
   * Repeated call with the same index returns an empty MaybeLocal.
   */
  template <class T>
  V8_INLINE MaybeLocal<T> GetDataFromSnapshotOnce(size_t index);

  /**
   * Returns the value that was set or restored by
   * SetContinuationPreservedEmbedderData(), if any.
   */
  Local<Value> GetContinuationPreservedEmbedderData();

  /**
   * Sets a value that will be stored on continuations and reset while the
   * continuation runs.
   */
  void SetContinuationPreservedEmbedderData(Local<Value> data);

  /**
   * Get statistics about the heap memory usage.
   */
  void GetHeapStatistics(HeapStatistics* heap_statistics);

  /**
   * Returns the number of spaces in the heap.
   */
  size_t NumberOfHeapSpaces();

  /**
   * Get the memory usage of a space in the heap.
   *
   * \param space_statistics The HeapSpaceStatistics object to fill in
   *   statistics.
   * \param index The index of the space to get statistics from, which ranges
   *   from 0 to NumberOfHeapSpaces() - 1.
   * \returns true on success.
   */
  bool GetHeapSpaceStatistics(HeapSpaceStatistics* space_statistics,
                              size_t index);

  /**
   * Returns the number of types of objects tracked in the heap at GC.
   */
  size_t NumberOfTrackedHeapObjectTypes();

  /**
   * Get statistics about objects in the heap.
   *
   * \param object_statistics The HeapObjectStatistics object to fill in
   *   statistics of objects of given type, which were live in the previous GC.
   * \param type_index The index of the type of object to fill details about,
   *   which ranges from 0 to NumberOfTrackedHeapObjectTypes() - 1.
   * \returns true on success.
   */
  bool GetHeapObjectStatisticsAtLastGC(HeapObjectStatistics* object_statistics,
                                       size_t type_index);

  /**
   * Get statistics about code and its metadata in the heap.
   *
   * \param object_statistics The HeapCodeStatistics object to fill in
   *   statistics of code, bytecode and their metadata.
   * \returns true on success.
   */
  bool GetHeapCodeAndMetadataStatistics(HeapCodeStatistics* object_statistics);

  /**
   * This API is experimental and may change significantly.
   *
   * Enqueues a memory measurement request and invokes the delegate with the
   * results.
   *
   * \param delegate the delegate that defines which contexts to measure and
   *   reports the results.
   *
   * \param execution promptness executing the memory measurement.
   *   The kEager value is expected to be used only in tests.
   */
  bool MeasureMemory(
      std::unique_ptr<MeasureMemoryDelegate> delegate,
      MeasureMemoryExecution execution = MeasureMemoryExecution::kDefault);

  /**
   * Get a call stack sample from the isolate.
   * \param state Execution state.
   * \param frames Caller allocated buffer to store stack frames.
   * \param frames_limit Maximum number of frames to capture. The buffer must
   *                     be large enough to hold the number of frames.
   * \param sample_info The sample info is filled up by the function
   *                    provides number of actual captured stack frames and
   *                    the current VM state.
   * \note GetStackSample should only be called when the JS thread is paused or
   *       interrupted. Otherwise the behavior is undefined.
   */
  void GetStackSample(const RegisterState& state, void** frames,
                      size_t frames_limit, SampleInfo* sample_info);

  /**
   * Adjusts the amount of registered external memory. Used to give V8 an
   * indication of the amount of externally allocated memory that is kept alive
   * by JavaScript objects. V8 uses this to decide when to perform global
   * garbage collections. Registering externally allocated memory will trigger
   * global garbage collections more often than it would otherwise in an attempt
   * to garbage collect the JavaScript objects that keep the externally
   * allocated memory alive.
   *
   * \param change_in_bytes the change in externally allocated memory that is
   *   kept alive by JavaScript objects.
   * \returns the adjusted value.
   */
  int64_t AdjustAmountOfExternalAllocatedMemory(int64_t change_in_bytes);

  /**
   * Returns heap profiler for this isolate. Will return NULL until the isolate
   * is initialized.
   */
  HeapProfiler* GetHeapProfiler();

  /**
   * Tells the VM whether the embedder is idle or not.
   */
  void SetIdle(bool is_idle);

  /** Returns the ArrayBuffer::Allocator used in this isolate. */
  ArrayBuffer::Allocator* GetArrayBufferAllocator();

  /** Returns true if this isolate has a current context. */
  bool InContext();

  /**
   * Returns the context of the currently running JavaScript, or the context
   * on the top of the stack if no JavaScript is running.
   */
  Local<Context> GetCurrentContext();

  /**
   * Returns either the last context entered through V8's C++ API, or the
   * context of the currently running microtask while processing microtasks.
   * If a context is entered while executing a microtask, that context is
   * returned.
   */
  Local<Context> GetEnteredOrMicrotaskContext();

  /**
   * Returns the Context that corresponds to the Incumbent realm in HTML spec.
   * https://html.spec.whatwg.org/multipage/webappapis.html#incumbent
   */
  Local<Context> GetIncumbentContext();

  /**
   * Schedules a v8::Exception::Error with the given message.
   * See ThrowException for more details. Templatized to provide compile-time
   * errors in case of too long strings (see v8::String::NewFromUtf8Literal).
   */
  template <int N>
  Local<Value> ThrowError(const char (&message)[N]) {
    return ThrowError(String::NewFromUtf8Literal(this, message));
  }
  Local<Value> ThrowError(Local<String> message);

  /**
   * Schedules an exception to be thrown when returning to JavaScript.  When an
   * exception has been scheduled it is illegal to invoke any JavaScript
   * operation; the caller must return immediately and only after the exception
   * has been handled does it become legal to invoke JavaScript operations.
   */
  Local<Value> ThrowException(Local<Value> exception);

  using GCCallback = void (*)(Isolate* isolate, GCType type,
                              GCCallbackFlags flags);
  using GCCallbackWithData = void (*)(Isolate* isolate, GCType type,
                                      GCCallbackFlags flags, void* data);

  /**
   * Enables the host application to receive a notification before a
   * garbage collection.
   *
   * \param callback The callback to be invoked. The callback is allowed to
   *     allocate but invocation is not re-entrant: a callback triggering
   *     garbage collection will not be called again. JS execution is prohibited
   *     from these callbacks. A single callback may only be registered once.
   * \param gc_type_filter A filter in case it should be applied.
   */
  void AddGCPrologueCallback(GCCallback callback,
                             GCType gc_type_filter = kGCTypeAll);

  /**
   * \copydoc AddGCPrologueCallback(GCCallback, GCType)
   *
   * \param data Additional data that should be passed to the callback.
   */
  void AddGCPrologueCallback(GCCallbackWithData callback, void* data = nullptr,
                             GCType gc_type_filter = kGCTypeAll);

  /**
   * This function removes a callback which was added by
   * `AddGCPrologueCallback`.
   *
   * \param callback the callback to remove.
   */
  void RemoveGCPrologueCallback(GCCallback callback);

  /**
   * \copydoc AddGCPrologueCallback(GCCallback)
   *
   * \param data Additional data that was used to install the callback.
   */
  void RemoveGCPrologueCallback(GCCallbackWithData, void* data = nullptr);

  /**
   * Enables the host application to receive a notification after a
   * garbage collection.
   *
   * \copydetails AddGCPrologueCallback(GCCallback, GCType)
   */
  void AddGCEpilogueCallback(GCCallback callback,
                             GCType gc_type_filter = kGCTypeAll);

  /**
   * \copydoc AddGCEpilogueCallback(GCCallback, GCType)
   *
   * \param data Additional data that should be passed to the callback.
   */
  void AddGCEpilogueCallback(GCCallbackWithData callback, void* data = nullptr,
                             GCType gc_type_filter = kGCTypeAll);

  /**
   * This function removes a callback which was added by
   * `AddGCEpilogueCallback`.
   *
   * \param callback the callback to remove.
   */
  void RemoveGCEpilogueCallback(GCCallback callback);

  /**
   * \copydoc RemoveGCEpilogueCallback(GCCallback)
   *
   * \param data Additional data that was used to install the callback.
   */
  void RemoveGCEpilogueCallback(GCCallbackWithData callback,
                                void* data = nullptr);

  /**
   * Sets an embedder roots handle that V8 should consider when performing
   * non-unified heap garbage collections. The intended use case is for setting
   * a custom handler after invoking `AttachCppHeap()`.
   *
   * V8 does not take ownership of the handler.
   */
  void SetEmbedderRootsHandler(EmbedderRootsHandler* handler);

  /**
   * Attaches a managed C++ heap as an extension to the JavaScript heap. The
   * embedder maintains ownership of the CppHeap. At most one C++ heap can be
   * attached to V8.
   *
   * Multi-threaded use requires the use of v8::Locker/v8::Unlocker, see
   * CppHeap.
   *
   * If a CppHeap is set via CreateParams, then this call is a noop.
   */
  V8_DEPRECATE_SOON(
      "Set the heap on Isolate creation using CreateParams instead.")
  void AttachCppHeap(CppHeap*);

  /**
   * Detaches a managed C++ heap if one was attached using `AttachCppHeap()`.
   *
   * If a CppHeap is set via CreateParams, then this call is a noop.
   */
  V8_DEPRECATE_SOON(
      "Set the heap on Isolate creation using CreateParams instead.")
  void DetachCppHeap();

  /**
   * \returns the C++ heap managed by V8. Only available if such a heap has been
   *   attached using `AttachCppHeap()`.
   */
  CppHeap* GetCppHeap() const;

  /**
   * Use for |AtomicsWaitCallback| to indicate the type of event it receives.
   */
  enum class AtomicsWaitEvent {
    /** Indicates that this call is happening before waiting. */
    kStartWait,
    /** `Atomics.wait()` finished because of an `Atomics.wake()` call. */
    kWokenUp,
    /** `Atomics.wait()` finished because it timed out. */
    kTimedOut,
    /** `Atomics.wait()` was interrupted through |TerminateExecution()|. */
    kTerminatedExecution,
    /** `Atomics.wait()` was stopped through |AtomicsWaitWakeHandle|. */
    kAPIStopped,
    /** `Atomics.wait()` did not wait, as the initial condition was not met. */
    kNotEqual
  };

  /**
   * Passed to |AtomicsWaitCallback| as a means of stopping an ongoing
   * `Atomics.wait` call.
   */
  class V8_EXPORT AtomicsWaitWakeHandle {
   public:
    /**
     * Stop this `Atomics.wait()` call and call the |AtomicsWaitCallback|
     * with |kAPIStopped|.
     *
     * This function may be called from another thread. The caller has to ensure
     * through proper synchronization that it is not called after
     * the finishing |AtomicsWaitCallback|.
     *
     * Note that the ECMAScript specification does not plan for the possibility
     * of wakeups that are neither coming from a timeout or an `Atomics.wake()`
     * call, so this may invalidate assumptions made by existing code.
     * The embedder may accordingly wish to schedule an exception in the
     * finishing |AtomicsWaitCallback|.
     */
    void Wake();
  };

  /**
   * Embedder callback for `Atomics.wait()` that can be added through
   * |SetAtomicsWaitCallback|.
   *
   * This will be called just before starting to wait with the |event| value
   * |kStartWait| and after finishing waiting with one of the other
   * values of |AtomicsWaitEvent| inside of an `Atomics.wait()` call.
   *
   * |array_buffer| will refer to the underlying SharedArrayBuffer,
   * |offset_in_bytes| to the location of the waited-on memory address inside
   * the SharedArrayBuffer.
   *
   * |value| and |timeout_in_ms| will be the values passed to
   * the `Atomics.wait()` call. If no timeout was used, |timeout_in_ms|
   * will be `INFINITY`.
   *
   * In the |kStartWait| callback, |stop_handle| will be an object that
   * is only valid until the corresponding finishing callback and that
   * can be used to stop the wait process while it is happening.
   *
   * This callback may schedule exceptions, *unless* |event| is equal to
   * |kTerminatedExecution|.
   */
  using AtomicsWaitCallback = void (*)(AtomicsWaitEvent event,
                                       Local<SharedArrayBuffer> array_buffer,
                                       size_t offset_in_bytes, int64_t value,
                                       double timeout_in_ms,
                                       AtomicsWaitWakeHandle* stop_handle,
                                       void* data);

  /**
   * Set a new |AtomicsWaitCallback|. This overrides an earlier
   * |AtomicsWaitCallback|, if there was any. If |callback| is nullptr,
   * this unsets the callback. |data| will be passed to the callback
   * as its last parameter.
   */
  void SetAtomicsWaitCallback(AtomicsWaitCallback callback, void* data);

  using GetExternallyAllocatedMemoryInBytesCallback = size_t (*)();

  /**
   * Set the callback that tells V8 how much memory is currently allocated
   * externally of the V8 heap. Ideally this memory is somehow connected to V8
   * objects and may get freed-up when the corresponding V8 objects get
   * collected by a V8 garbage collection.
   */
  void SetGetExternallyAllocatedMemoryInBytesCallback(
      GetExternallyAllocatedMemoryInBytesCallback callback);

  /**
   * Forcefully terminate the current thread of JavaScript execution
   * in the given isolate.
   *
   * This method can be used by any thread even if that thread has not
   * acquired the V8 lock with a Locker object.
   */
  void TerminateExecution();

  /**
   * Is V8 terminating JavaScript execution.
   *
   * Returns true if JavaScript execution is currently terminating
   * because of a call to TerminateExecution.  In that case there are
   * still JavaScript frames on the stack and the termination
   * exception is still active.
   */
  bool IsExecutionTerminating();

  /**
   * Resume execution capability in the given isolate, whose execution
   * was previously forcefully terminated using TerminateExecution().
   *
   * When execution is forcefully terminated using TerminateExecution(),
   * the isolate can not resume execution until all JavaScript frames
   * have propagated the uncatchable exception which is generated.  This
   * method allows the program embedding the engine to handle the
   * termination event and resume execution capability, even if
   * JavaScript frames remain on the stack.
   *
   * This method can be used by any thread even if that thread has not
   * acquired the V8 lock with a Locker object.
   */
  void CancelTerminateExecution();

  /**
   * Request V8 to interrupt long running JavaScript code and invoke
   * the given |callback| passing the given |data| to it. After |callback|
   * returns control will be returned to the JavaScript code.
   * There may be a number of interrupt requests in flight.
   * Can be called from another thread without acquiring a |Locker|.
   * Registered |callback| must not reenter interrupted Isolate.
   */
  void RequestInterrupt(InterruptCallback callback, void* data);

  /**
   * Returns true if there is ongoing background work within V8 that will
   * eventually post a foreground task, like asynchronous WebAssembly
   * compilation.
   */
  bool HasPendingBackgroundTasks();

  /**
   * Request garbage collection in this Isolate. It is only valid to call this
   * function if --expose_gc was specified.
   *
   * This should only be used for testing purposes and not to enforce a garbage
   * collection schedule. It has strong negative impact on the garbage
   * collection performance. Use MemoryPressureNotification() instead to
   * influence the garbage collection schedule.
   */
  void RequestGarbageCollectionForTesting(GarbageCollectionType type);

  /**
   * Request garbage collection with a specific embedderstack state in this
   * Isolate. It is only valid to call this function if --expose_gc was
   * specified.
   *
   * This should only be used for testing purposes and not to enforce a garbage
   * collection schedule. It has strong negative impact on the garbage
   * collection performance. Use MemoryPressureNotification() instead to
   * influence the garbage collection schedule.
   */
  void RequestGarbageCollectionForTesting(GarbageCollectionType type,
                                          StackState stack_state);

  /**
   * Set the callback to invoke for logging event.
   */
  void SetEventLogger(LogEventCallback that);

  /**
   * Adds a callback to notify the host application right before a script
   * is about to run. If a script re-enters the runtime during executing, the
   * BeforeCallEnteredCallback is invoked for each re-entrance.
   * Executing scripts inside the callback will re-trigger the callback.
   */
  void AddBeforeCallEnteredCallback(BeforeCallEnteredCallback callback);

  /**
   * Removes callback that was installed by AddBeforeCallEnteredCallback.
   */
  void RemoveBeforeCallEnteredCallback(BeforeCallEnteredCallback callback);

  /**
   * Adds a callback to notify the host application when a script finished
   * running.  If a script re-enters the runtime during executing, the
   * CallCompletedCallback is only invoked when the outer-most script
   * execution ends.  Executing scripts inside the callback do not trigger
   * further callbacks.
   */
  void AddCallCompletedCallback(CallCompletedCallback callback);

  /**
   * Removes callback that was installed by AddCallCompletedCallback.
   */
  void RemoveCallCompletedCallback(CallCompletedCallback callback);

  /**
   * Set the PromiseHook callback for various promise lifecycle
   * events.
   */
  void SetPromiseHook(PromiseHook hook);

  /**
   * Set callback to notify about promise reject with no handler, or
   * revocation of such a previous notification once the handler is added.
   */
  void SetPromiseRejectCallback(PromiseRejectCallback callback);

  /**
   * Runs the default MicrotaskQueue until it gets empty and perform other
   * microtask checkpoint steps, such as calling ClearKeptObjects. Asserts that
   * the MicrotasksPolicy is not kScoped. Any exceptions thrown by microtask
   * callbacks are swallowed.
   */
  void PerformMicrotaskCheckpoint();

  /**
   * Enqueues the callback to the default MicrotaskQueue
   */
  void EnqueueMicrotask(Local<Function> microtask);

  /**
   * Enqueues the callback to the default MicrotaskQueue
   */
  void EnqueueMicrotask(MicrotaskCallback callback, void* data = nullptr);

  /**
   * Controls how Microtasks are invoked. See MicrotasksPolicy for details.
   */
  void SetMicrotasksPolicy(MicrotasksPolicy policy);

  /**
   * Returns the policy controlling how Microtasks are invoked.
   */
  MicrotasksPolicy GetMicrotasksPolicy() const;

  /**
   * Adds a callback to notify the host application after
   * microtasks were run on the default MicrotaskQueue. The callback is
   * triggered by explicit RunMicrotasks call or automatic microtasks execution
   * (see SetMicrotaskPolicy).
   *
   * Callback will trigger even if microtasks were attempted to run,
   * but the microtasks queue was empty and no single microtask was actually
   * executed.
   *
   * Executing scripts inside the callback will not re-trigger microtasks and
   * the callback.
   */
  void AddMicrotasksCompletedCallback(
      MicrotasksCompletedCallbackWithData callback, void* data = nullptr);

  /**
   * Removes callback that was installed by AddMicrotasksCompletedCallback.
   */
  void RemoveMicrotasksCompletedCallback(
      MicrotasksCompletedCallbackWithData callback, void* data = nullptr);

  /**
   * Sets a callback for counting the number of times a feature of V8 is used.
   */
  void SetUseCounterCallback(UseCounterCallback callback);

  /**
   * Enables the host application to provide a mechanism for recording
   * statistics counters.
   */
  void SetCounterFunction(CounterLookupCallback);

  /**
   * Enables the host application to provide a mechanism for recording
   * histograms. The CreateHistogram function returns a
   * histogram which will later be passed to the AddHistogramSample
   * function.
   */
  void SetCreateHistogramFunction(CreateHistogramCallback);
  void SetAddHistogramSampleFunction(AddHistogramSampleCallback);

  /**
   * Enables the host application to provide a mechanism for recording
   * event based metrics. In order to use this interface
   *   include/v8-metrics.h
   * needs to be included and the recorder needs to be derived from the
   * Recorder base class defined there.
   * This method can only be called once per isolate and must happen during
   * isolate initialization before background threads are spawned.
   */
  void SetMetricsRecorder(
      const std::shared_ptr<metrics::Recorder>& metrics_recorder);

  /**
   * Enables the host application to provide a mechanism for recording a
   * predefined set of data as crash keys to be used in postmortem debugging in
   * case of a crash.
   */
  void SetAddCrashKeyCallback(AddCrashKeyCallback);

  /**
   * Optional notification that the embedder is idle.
   * V8 uses the notification to perform garbage collection.
   * This call can be used repeatedly if the embedder remains idle.
   * Returns true if the embedder should stop calling IdleNotificationDeadline
   * until real work has been done.  This indicates that V8 has done
   * as much cleanup as it will be able to do.
   *
   * The deadline_in_seconds argument specifies the deadline V8 has to finish
   * garbage collection work. deadline_in_seconds is compared with
   * MonotonicallyIncreasingTime() and should be based on the same timebase as
   * that function. There is no guarantee that the actual work will be done
   * within the time limit.
   */
  V8_DEPRECATE_SOON(
      "Use MemoryPressureNotification() to influence the GC schedule.")
  bool IdleNotificationDeadline(double deadline_in_seconds);

  /**
   * Optional notification that the system is running low on memory.
   * V8 uses these notifications to attempt to free memory.
   */
  void LowMemoryNotification();

  /**
   * Optional notification that a context has been disposed. V8 uses these
   * notifications to guide the GC heuristic and cancel FinalizationRegistry
   * cleanup tasks. Returns the number of context disposals - including this one
   * - since the last time V8 had a chance to clean up.
   *
   * The optional parameter |dependant_context| specifies whether the disposed
   * context was depending on state from other contexts or not.
   */
  int ContextDisposedNotification(bool dependant_context = true);

  /**
   * Optional notification that the isolate switched to the foreground.
   * V8 uses these notifications to guide heuristics.
   */
  void IsolateInForegroundNotification();

  /**
   * Optional notification that the isolate switched to the background.
   * V8 uses these notifications to guide heuristics.
   */
  void IsolateInBackgroundNotification();

  /**
   * Optional notification to tell V8 the current performance requirements
   * of the embedder based on RAIL.
   * V8 uses these notifications to guide heuristics.
   * This is an unfinished experimental feature. Semantics and implementation
   * may change frequently.
   */
  void SetRAILMode(RAILMode rail_mode);

  /**
   * Update load start time of the RAIL mode
   */
  void UpdateLoadStartTime();

  /**
   * Optional notification to tell V8 the current isolate is used for debugging
   * and requires higher heap limit.
   */
  void IncreaseHeapLimitForDebugging();

  /**
   * Restores the original heap limit after IncreaseHeapLimitForDebugging().
   */
  void RestoreOriginalHeapLimit();

  /**
   * Returns true if the heap limit was increased for debugging and the
   * original heap limit was not restored yet.
   */
  bool IsHeapLimitIncreasedForDebugging();

  /**
   * Allows the host application to provide the address of a function that is
   * notified each time code is added, moved or removed.
   *
   * \param options options for the JIT code event handler.
   * \param event_handler the JIT code event handler, which will be invoked
   *     each time code is added, moved or removed.
   * \note \p event_handler won't get notified of existent code.
   * \note since code removal notifications are not currently issued, the
   *     \p event_handler may get notifications of code that overlaps earlier
   *     code notifications. This happens when code areas are reused, and the
   *     earlier overlapping code areas should therefore be discarded.
   * \note the events passed to \p event_handler and the strings they point to
   *     are not guaranteed to live past each call. The \p event_handler must
   *     copy strings and other parameters it needs to keep around.
   * \note the set of events declared in JitCodeEvent::EventType is expected to
   *     grow over time, and the JitCodeEvent structure is expected to accrue
   *     new members. The \p event_handler function must ignore event codes
   *     it does not recognize to maintain future compatibility.
   * \note Use Isolate::CreateParams to get events for code executed during
   *     Isolate setup.
   */
  void SetJitCodeEventHandler(JitCodeEventOptions options,
                              JitCodeEventHandler event_handler);

  /**
   * Modifies the stack limit for this Isolate.
   *
   * \param stack_limit An address beyond which the Vm's stack may not grow.
   *
   * \note  If you are using threads then you should hold the V8::Locker lock
   *     while setting the stack limit and you must set a non-default stack
   *     limit separately for each thread.
   */
  void SetStackLimit(uintptr_t stack_limit);

  /**
   * Returns a memory range that can potentially contain jitted code. Code for
   * V8's 'builtins' will not be in this range if embedded builtins is enabled.
   *
   * On Win64, embedders are advised to install function table callbacks for
   * these ranges, as default SEH won't be able to unwind through jitted code.
   * The first page of the code range is reserved for the embedder and is
   * committed, writable, and executable, to be used to store unwind data, as
   * documented in
   * https://docs.microsoft.com/en-us/cpp/build/exception-handling-x64.
   *
   * Might be empty on other platforms.
   *
   * https://code.google.com/p/v8/issues/detail?id=3598
   */
  void GetCodeRange(void** start, size_t* length_in_bytes);

  /**
   * As GetCodeRange, but for embedded builtins (these live in a distinct
   * memory region from other V8 Code objects).
   */
  void GetEmbeddedCodeRange(const void** start, size_t* length_in_bytes);

  /**
   * Returns the JSEntryStubs necessary for use with the Unwinder API.
   */
  JSEntryStubs GetJSEntryStubs();

  static constexpr size_t kMinCodePagesBufferSize = 32;

  /**
   * Copies the code heap pages currently in use by V8 into |code_pages_out|.
   * |code_pages_out| must have at least kMinCodePagesBufferSize capacity and
   * must be empty.
   *
   * Signal-safe, does not allocate, does not access the V8 heap.
   * No code on the stack can rely on pages that might be missing.
   *
   * Returns the number of pages available to be copied, which might be greater
   * than |capacity|. In this case, only |capacity| pages will be copied into
   * |code_pages_out|. The caller should provide a bigger buffer on the next
   * call in order to get all available code pages, but this is not required.
   */
  size_t CopyCodePages(size_t capacity, MemoryRange* code_pages_out);

  /** Set the callback to invoke in case of fatal errors. */
  void SetFatalErrorHandler(FatalErrorCallback that);

  /** Set the callback to invoke in case of OOM errors. */
  void SetOOMErrorHandler(OOMErrorCallback that);

  /**
   * Add a callback to invoke in case the heap size is close to the heap limit.
   * If multiple callbacks are added, only the most recently added callback is
   * invoked.
   */
  void AddNearHeapLimitCallback(NearHeapLimitCallback callback, void* data);

  /**
   * Remove the given callback and restore the heap limit to the
   * given limit. If the given limit is zero, then it is ignored.
   * If the current heap size is greater than the given limit,
   * then the heap limit is restored to the minimal limit that
   * is possible for the current heap size.
   */
  void RemoveNearHeapLimitCallback(NearHeapLimitCallback callback,
                                   size_t heap_limit);

  /**
   * If the heap limit was changed by the NearHeapLimitCallback, then the
   * initial heap limit will be restored once the heap size falls below the
   * given threshold percentage of the initial heap limit.
   * The threshold percentage is a number in (0.0, 1.0) range.
   */
  void AutomaticallyRestoreInitialHeapLimit(double threshold_percent = 0.5);

  /**
   * Set the callback to invoke to check if code generation from
   * strings should be allowed.
   */
  void SetModifyCodeGenerationFromStringsCallback(
      ModifyCodeGenerationFromStringsCallback2 callback);

  /**
   * Set the callback to invoke to check if wasm code generation should
   * be allowed.
   */
  void SetAllowWasmCodeGenerationCallback(
      AllowWasmCodeGenerationCallback callback);

  /**
   * Embedder over{ride|load} injection points for wasm APIs. The expectation
   * is that the embedder sets them at most once.
   */
  void SetWasmModuleCallback(ExtensionCallback callback);
  void SetWasmInstanceCallback(ExtensionCallback callback);

  void SetWasmStreamingCallback(WasmStreamingCallback callback);

  void SetWasmAsyncResolvePromiseCallback(
      WasmAsyncResolvePromiseCallback callback);

  void SetWasmLoadSourceMapCallback(WasmLoadSourceMapCallback callback);

  void SetWasmImportedStringsEnabledCallback(
      WasmImportedStringsEnabledCallback callback);

  void SetSharedArrayBufferConstructorEnabledCallback(
      SharedArrayBufferConstructorEnabledCallback callback);

  void SetWasmJSPIEnabledCallback(WasmJSPIEnabledCallback callback);

  /**
   * Register callback to control whether compile hints magic comments are
   * enabled.
   */
  void SetJavaScriptCompileHintsMagicEnabledCallback(
      JavaScriptCompileHintsMagicEnabledCallback callback);

  /**
   * This function can be called by the embedder to signal V8 that the dynamic
   * enabling of features has finished. V8 can now set up dynamically added
   * features.
   */
  void InstallConditionalFeatures(Local<Context> context);

  /**
   * Check if V8 is dead and therefore unusable.  This is the case after
   * fatal errors such as out-of-memory situations.
   */
  bool IsDead();

  /**
   * Adds a message listener (errors only).
   *
   * The same message listener can be added more than once and in that
   * case it will be called more than once for each message.
   *
   * If data is specified, it will be passed to the callback when it is called.
   * Otherwise, the exception object will be passed to the callback instead.
   */
  bool AddMessageListener(MessageCallback that,
                          Local<Value> data = Local<Value>());

  /**
   * Adds a message listener.
   *
   * The same message listener can be added more than once and in that
   * case it will be called more than once for each message.
   *
   * If data is specified, it will be passed to the callback when it is called.
   * Otherwise, the exception object will be passed to the callback instead.
   *
   * A listener can listen for particular error levels by providing a mask.
   */
  bool AddMessageListenerWithErrorLevel(MessageCallback that,
                                        int message_levels,
                                        Local<Value> data = Local<Value>());

  /**
   * Remove all message listeners from the specified callback function.
   */
  void RemoveMessageListeners(MessageCallback that);

  /** Callback function for reporting failed access checks.*/
  void SetFailedAccessCheckCallbackFunction(FailedAccessCheckCallback);

  /**
   * Tells V8 to capture current stack trace when uncaught exception occurs
   * and report it to the message listeners. The option is off by default.
   */
  void SetCaptureStackTraceForUncaughtExceptions(
      bool capture, int frame_limit = 10,
      StackTrace::StackTraceOptions options = StackTrace::kOverview);

  /**
   * Iterates through all external resources referenced from current isolate
   * heap.  GC is not invoked prior to iterating, therefore there is no
   * guarantee that visited objects are still alive.
   */
  V8_DEPRECATE_SOON("Will be removed without replacement. crbug.com/v8/14172")
  void VisitExternalResources(ExternalResourceVisitor* visitor);

  /**
   * Check if this isolate is in use.
   * True if at least one thread Enter'ed this isolate.
   */
  bool IsInUse();

  /**
   * Set whether calling Atomics.wait (a function that may block) is allowed in
   * this isolate. This can also be configured via
   * CreateParams::allow_atomics_wait.
   */
  void SetAllowAtomicsWait(bool allow);

  /**
   * Time zone redetection indicator for
   * DateTimeConfigurationChangeNotification.
   *
   * kSkip indicates V8 that the notification should not trigger redetecting
   * host time zone. kRedetect indicates V8 that host time zone should be
   * redetected, and used to set the default time zone.
   *
   * The host time zone detection may require file system access or similar
   * operations unlikely to be available inside a sandbox. If v8 is run inside a
   * sandbox, the host time zone has to be detected outside the sandbox before
   * calling DateTimeConfigurationChangeNotification function.
   */
  enum class TimeZoneDetection { kSkip, kRedetect };

  /**
   * Notification that the embedder has changed the time zone, daylight savings
   * time or other date / time configuration parameters. V8 keeps a cache of
   * various values used for date / time computation. This notification will
   * reset those cached values for the current context so that date / time
   * configuration changes would be reflected.
   *
   * This API should not be called more than needed as it will negatively impact
   * the performance of date operations.
   */
  void DateTimeConfigurationChangeNotification(
      TimeZoneDetection time_zone_detection = TimeZoneDetection::kSkip);

  /**
   * Notification that the embedder has changed the locale. V8 keeps a cache of
   * various values used for locale computation. This notification will reset
   * those cached values for the current context so that locale configuration
   * changes would be reflected.
   *
   * This API should not be called more than needed as it will negatively impact
   * the performance of locale operations.
   */
  void LocaleConfigurationChangeNotification();

  /**
   * Returns the default locale in a string if Intl support is enabled.
   * Otherwise returns an empty string.
   */
  std::string GetDefaultLocale();

  Isolate() = delete;
  ~Isolate() = delete;
  Isolate(const Isolate&) = delete;
  Isolate& operator=(const Isolate&) = delete;
  // Deleting operator new and delete here is allowed as ctor and dtor is also
  // deleted.
  void* operator new(size_t size) = delete;
  void* operator new[](size_t size) = delete;
  void operator delete(void*, size_t) = delete;
  void operator delete[](void*, size_t) = delete;

 private:
  template <class K, class V, class Traits>
  friend class PersistentValueMapBase;

  internal::Address* GetDataFromSnapshotOnce(size_t index);
  void ReportExternalAllocationLimitReached();
};

void Isolate::SetData(uint32_t slot, void* data) {
  using I = internal::Internals;
  I::SetEmbedderData(this, slot, data);
}

void* Isolate::GetData(uint32_t slot) {
  using I = internal::Internals;
  return I::GetEmbedderData(this, slot);
}

uint32_t Isolate::GetNumberOfDataSlots() {
  using I = internal::Internals;
  return I::kNumIsolateDataSlots;
}

template <class T>
MaybeLocal<T> Isolate::GetDataFromSnapshotOnce(size_t index) {
  if (auto slot = GetDataFromSnapshotOnce(index); slot) {
    internal::PerformCastCheck(
        internal::ValueHelper::SlotAsValue<T, false>(slot));
    return Local<T>::FromSlot(slot);
  }
  return {};
}

}  // namespace v8

#endif  // INCLUDE_V8_ISOLATE_H_
