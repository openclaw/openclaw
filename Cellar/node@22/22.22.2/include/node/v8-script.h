// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_SCRIPT_H_
#define INCLUDE_V8_SCRIPT_H_

#include <stddef.h>
#include <stdint.h>

#include <memory>
#include <tuple>
#include <vector>

#include "v8-callbacks.h"     // NOLINT(build/include_directory)
#include "v8-data.h"          // NOLINT(build/include_directory)
#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-maybe.h"         // NOLINT(build/include_directory)
#include "v8-memory-span.h"   // NOLINT(build/include_directory)
#include "v8-message.h"       // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Function;
class Message;
class Object;
class PrimitiveArray;
class Script;

namespace internal {
class BackgroundDeserializeTask;
struct ScriptStreamingData;
}  // namespace internal

/**
 * A container type that holds relevant metadata for module loading.
 *
 * This is passed back to the embedder as part of
 * HostImportModuleDynamicallyCallback for module loading.
 */
class V8_EXPORT ScriptOrModule {
 public:
  /**
   * The name that was passed by the embedder as ResourceName to the
   * ScriptOrigin. This can be either a v8::String or v8::Undefined.
   */
  Local<Value> GetResourceName();

  /**
   * The options that were passed by the embedder as HostDefinedOptions to
   * the ScriptOrigin.
   */
  Local<Data> HostDefinedOptions();
};

/**
 * A compiled JavaScript script, not yet tied to a Context.
 */
class V8_EXPORT UnboundScript : public Data {
 public:
  /**
   * Binds the script to the currently entered context.
   */
  Local<Script> BindToCurrentContext();

  int GetId() const;
  Local<Value> GetScriptName();

  /**
   * Data read from magic sourceURL comments.
   */
  Local<Value> GetSourceURL();
  /**
   * Data read from magic sourceMappingURL comments.
   */
  Local<Value> GetSourceMappingURL();

  /**
   * Returns zero based line number of the code_pos location in the script.
   * -1 will be returned if no information available.
   */
  int GetLineNumber(int code_pos = 0);

  /**
   * Returns zero based column number of the code_pos location in the script.
   * -1 will be returned if no information available.
   */
  int GetColumnNumber(int code_pos = 0);

  static const int kNoScriptId = 0;
};

/**
 * A compiled JavaScript module, not yet tied to a Context.
 */
class V8_EXPORT UnboundModuleScript : public Data {
 public:
  /**
   * Data read from magic sourceURL comments.
   */
  Local<Value> GetSourceURL();
  /**
   * Data read from magic sourceMappingURL comments.
   */
  Local<Value> GetSourceMappingURL();
};

/**
 * A location in JavaScript source.
 */
class V8_EXPORT Location {
 public:
  int GetLineNumber() { return line_number_; }
  int GetColumnNumber() { return column_number_; }

  Location(int line_number, int column_number)
      : line_number_(line_number), column_number_(column_number) {}

 private:
  int line_number_;
  int column_number_;
};

class V8_EXPORT ModuleRequest : public Data {
 public:
  /**
   * Returns the module specifier for this ModuleRequest.
   */
  Local<String> GetSpecifier() const;

  /**
   * Returns the source code offset of this module request.
   * Use Module::SourceOffsetToLocation to convert this to line/column numbers.
   */
  int GetSourceOffset() const;

  /**
   * Contains the import attributes for this request in the form:
   * [key1, value1, source_offset1, key2, value2, source_offset2, ...].
   * The keys and values are of type v8::String, and the source offsets are of
   * type Int32. Use Module::SourceOffsetToLocation to convert the source
   * offsets to Locations with line/column numbers.
   *
   * All attributes present in the module request will be supplied in this
   * list, regardless of whether they are supported by the host. Per
   * https://tc39.es/proposal-import-attributes/#sec-hostgetsupportedimportattributes,
   * hosts are expected to throw for attributes that they do not support (as
   * opposed to, for example, ignoring them).
   */
  Local<FixedArray> GetImportAttributes() const;

  V8_DEPRECATE_SOON("Use GetImportAttributes instead")
  Local<FixedArray> GetImportAssertions() const {
    return GetImportAttributes();
  }

  V8_INLINE static ModuleRequest* Cast(Data* data);

 private:
  static void CheckCast(Data* obj);
};

/**
 * A compiled JavaScript module.
 */
class V8_EXPORT Module : public Data {
 public:
  /**
   * The different states a module can be in.
   *
   * This corresponds to the states used in ECMAScript except that "evaluated"
   * is split into kEvaluated and kErrored, indicating success and failure,
   * respectively.
   */
  enum Status {
    kUninstantiated,
    kInstantiating,
    kInstantiated,
    kEvaluating,
    kEvaluated,
    kErrored
  };

  /**
   * Returns the module's current status.
   */
  Status GetStatus() const;

  /**
   * For a module in kErrored status, this returns the corresponding exception.
   */
  Local<Value> GetException() const;

  /**
   * Returns the ModuleRequests for this module.
   */
  Local<FixedArray> GetModuleRequests() const;

  /**
   * For the given source text offset in this module, returns the corresponding
   * Location with line and column numbers.
   */
  Location SourceOffsetToLocation(int offset) const;

  /**
   * Returns the identity hash for this object.
   */
  int GetIdentityHash() const;

  using ResolveModuleCallback = MaybeLocal<Module> (*)(
      Local<Context> context, Local<String> specifier,
      Local<FixedArray> import_assertions, Local<Module> referrer);

  /**
   * Instantiates the module and its dependencies.
   *
   * Returns an empty Maybe<bool> if an exception occurred during
   * instantiation. (In the case where the callback throws an exception, that
   * exception is propagated.)
   */
  V8_WARN_UNUSED_RESULT Maybe<bool> InstantiateModule(
      Local<Context> context, ResolveModuleCallback callback);

  /**
   * Evaluates the module and its dependencies.
   *
   * If status is kInstantiated, run the module's code and return a Promise
   * object. On success, set status to kEvaluated and resolve the Promise with
   * the completion value; on failure, set status to kErrored and reject the
   * Promise with the error.
   *
   * If IsGraphAsync() is false, the returned Promise is settled.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Value> Evaluate(Local<Context> context);

  /**
   * Returns the namespace object of this module.
   *
   * The module's status must be at least kInstantiated.
   */
  Local<Value> GetModuleNamespace();

  /**
   * Returns the corresponding context-unbound module script.
   *
   * The module must be unevaluated, i.e. its status must not be kEvaluating,
   * kEvaluated or kErrored.
   */
  Local<UnboundModuleScript> GetUnboundModuleScript();

  /**
   * Returns the underlying script's id.
   *
   * The module must be a SourceTextModule and must not have a kErrored status.
   */
  int ScriptId() const;

  /**
   * Returns whether this module or any of its requested modules is async,
   * i.e. contains top-level await.
   *
   * The module's status must be at least kInstantiated.
   */
  bool IsGraphAsync() const;

  /**
   * Returns whether the module is a SourceTextModule.
   */
  bool IsSourceTextModule() const;

  /**
   * Returns whether the module is a SyntheticModule.
   */
  bool IsSyntheticModule() const;

  /*
   * Callback defined in the embedder.  This is responsible for setting
   * the module's exported values with calls to SetSyntheticModuleExport().
   * The callback must return a resolved Promise to indicate success (where no
   * exception was thrown) and return an empy MaybeLocal to indicate falure
   * (where an exception was thrown).
   */
  using SyntheticModuleEvaluationSteps =
      MaybeLocal<Value> (*)(Local<Context> context, Local<Module> module);

  /**
   * Creates a new SyntheticModule with the specified export names, where
   * evaluation_steps will be executed upon module evaluation.
   * export_names must not contain duplicates.
   * module_name is used solely for logging/debugging and doesn't affect module
   * behavior.
   */
  static Local<Module> CreateSyntheticModule(
      Isolate* isolate, Local<String> module_name,
      const MemorySpan<const Local<String>>& export_names,
      SyntheticModuleEvaluationSteps evaluation_steps);

  /**
   * Set this module's exported value for the name export_name to the specified
   * export_value. This method must be called only on Modules created via
   * CreateSyntheticModule.  An error will be thrown if export_name is not one
   * of the export_names that were passed in that CreateSyntheticModule call.
   * Returns Just(true) on success, Nothing<bool>() if an error was thrown.
   */
  V8_WARN_UNUSED_RESULT Maybe<bool> SetSyntheticModuleExport(
      Isolate* isolate, Local<String> export_name, Local<Value> export_value);

  /**
   * Search the modules requested directly or indirectly by the module for
   * any top-level await that has not yet resolved. If there is any, the
   * returned pair of vectors (of equal size) contain the unresolved module
   * and corresponding message with the pending top-level await.
   * An embedder may call this before exiting to improve error messages.
   */
  std::pair<LocalVector<Module>, LocalVector<Message>>
  GetStalledTopLevelAwaitMessages(Isolate* isolate);

  V8_INLINE static Module* Cast(Data* data);

 private:
  static void CheckCast(Data* obj);
};

/**
 * A compiled JavaScript script, tied to a Context which was active when the
 * script was compiled.
 */
class V8_EXPORT Script : public Data {
 public:
  /**
   * A shorthand for ScriptCompiler::Compile().
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<Script> Compile(
      Local<Context> context, Local<String> source,
      ScriptOrigin* origin = nullptr);

  /**
   * Runs the script returning the resulting value. It will be run in the
   * context in which it was created (ScriptCompiler::CompileBound or
   * UnboundScript::BindToCurrentContext()).
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Value> Run(Local<Context> context);
  V8_WARN_UNUSED_RESULT MaybeLocal<Value> Run(Local<Context> context,
                                              Local<Data> host_defined_options);

  /**
   * Returns the corresponding context-unbound script.
   */
  Local<UnboundScript> GetUnboundScript();

  /**
   * The name that was passed by the embedder as ResourceName to the
   * ScriptOrigin. This can be either a v8::String or v8::Undefined.
   */
  Local<Value> GetResourceName();

  /**
   * If the script was compiled, returns the positions of lazy functions which
   * were eventually compiled and executed.
   */
  std::vector<int> GetProducedCompileHints() const;
};

enum class ScriptType { kClassic, kModule };

/**
 * For compiling scripts.
 */
class V8_EXPORT ScriptCompiler {
 public:
  class ConsumeCodeCacheTask;

  /**
   * Compilation data that the embedder can cache and pass back to speed up
   * future compilations. The data is produced if the CompilerOptions passed to
   * the compilation functions in ScriptCompiler contains produce_data_to_cache
   * = true. The data to cache can then can be retrieved from
   * UnboundScript.
   */
  struct V8_EXPORT CachedData {
    enum BufferPolicy { BufferNotOwned, BufferOwned };

    CachedData()
        : data(nullptr),
          length(0),
          rejected(false),
          buffer_policy(BufferNotOwned) {}

    // If buffer_policy is BufferNotOwned, the caller keeps the ownership of
    // data and guarantees that it stays alive until the CachedData object is
    // destroyed. If the policy is BufferOwned, the given data will be deleted
    // (with delete[]) when the CachedData object is destroyed.
    CachedData(const uint8_t* data, int length,
               BufferPolicy buffer_policy = BufferNotOwned);
    ~CachedData();

    enum CompatibilityCheckResult {
      // Don't change order/existing values of this enum since it keys into the
      // `code_cache_reject_reason` histogram. Append-only!
      kSuccess = 0,
      kMagicNumberMismatch = 1,
      kVersionMismatch = 2,
      kSourceMismatch = 3,
      kFlagsMismatch = 5,
      kChecksumMismatch = 6,
      kInvalidHeader = 7,
      kLengthMismatch = 8,
      kReadOnlySnapshotChecksumMismatch = 9,

      // This should always point at the last real enum value.
      kLast = kReadOnlySnapshotChecksumMismatch
    };

    // Check if the CachedData can be loaded in the given isolate.
    CompatibilityCheckResult CompatibilityCheck(Isolate* isolate);

    // TODO(marja): Async compilation; add constructors which take a callback
    // which will be called when V8 no longer needs the data.
    const uint8_t* data;
    int length;
    bool rejected;
    BufferPolicy buffer_policy;

    // Prevent copying.
    CachedData(const CachedData&) = delete;
    CachedData& operator=(const CachedData&) = delete;
  };

  enum class InMemoryCacheResult {
    // V8 did not attempt to find this script in its in-memory cache.
    kNotAttempted,

    // V8 found a previously compiled copy of this script in its in-memory
    // cache. Any data generated by a streaming compilation or background
    // deserialization was abandoned.
    kHit,

    // V8 didn't have any previously compiled data for this script.
    kMiss,

    // V8 had some previously compiled data for an identical script, but the
    // data was incomplete.
    kPartial,
  };

  // Details about what happened during a compilation.
  struct CompilationDetails {
    InMemoryCacheResult in_memory_cache_result =
        InMemoryCacheResult::kNotAttempted;

    static constexpr int64_t kTimeNotMeasured = -1;
    int64_t foreground_time_in_microseconds = kTimeNotMeasured;
    int64_t background_time_in_microseconds = kTimeNotMeasured;
  };

  /**
   * Source code which can be then compiled to a UnboundScript or Script.
   */
  class Source {
   public:
    // Source takes ownership of both CachedData and CodeCacheConsumeTask.
    // The caller *must* ensure that the cached data is from a trusted source.
    V8_INLINE Source(Local<String> source_string, const ScriptOrigin& origin,
                     CachedData* cached_data = nullptr,
                     ConsumeCodeCacheTask* consume_cache_task = nullptr);
    // Source takes ownership of both CachedData and CodeCacheConsumeTask.
    V8_INLINE explicit Source(
        Local<String> source_string, CachedData* cached_data = nullptr,
        ConsumeCodeCacheTask* consume_cache_task = nullptr);
    V8_INLINE Source(Local<String> source_string, const ScriptOrigin& origin,
                     CompileHintCallback callback, void* callback_data);
    V8_INLINE ~Source() = default;

    // Ownership of the CachedData or its buffers is *not* transferred to the
    // caller. The CachedData object is alive as long as the Source object is
    // alive.
    V8_INLINE const CachedData* GetCachedData() const;

    V8_INLINE const ScriptOriginOptions& GetResourceOptions() const;

    V8_INLINE const CompilationDetails& GetCompilationDetails() const;

   private:
    friend class ScriptCompiler;

    Local<String> source_string;

    // Origin information
    Local<Value> resource_name;
    int resource_line_offset = -1;
    int resource_column_offset = -1;
    ScriptOriginOptions resource_options;
    Local<Value> source_map_url;
    Local<Data> host_defined_options;

    // Cached data from previous compilation (if a kConsume*Cache flag is
    // set), or hold newly generated cache data (kProduce*Cache flags) are
    // set when calling a compile method.
    std::unique_ptr<CachedData> cached_data;
    std::unique_ptr<ConsumeCodeCacheTask> consume_cache_task;

    // For requesting compile hints from the embedder.
    CompileHintCallback compile_hint_callback = nullptr;
    void* compile_hint_callback_data = nullptr;

    // V8 writes this data and never reads it. It exists only to be informative
    // to the embedder.
    CompilationDetails compilation_details;
  };

  /**
   * For streaming incomplete script data to V8. The embedder should implement a
   * subclass of this class.
   */
  class V8_EXPORT ExternalSourceStream {
   public:
    virtual ~ExternalSourceStream() = default;

    /**
     * V8 calls this to request the next chunk of data from the embedder. This
     * function will be called on a background thread, so it's OK to block and
     * wait for the data, if the embedder doesn't have data yet. Returns the
     * length of the data returned. When the data ends, GetMoreData should
     * return 0. Caller takes ownership of the data.
     *
     * When streaming UTF-8 data, V8 handles multi-byte characters split between
     * two data chunks, but doesn't handle multi-byte characters split between
     * more than two data chunks. The embedder can avoid this problem by always
     * returning at least 2 bytes of data.
     *
     * When streaming UTF-16 data, V8 does not handle characters split between
     * two data chunks. The embedder has to make sure that chunks have an even
     * length.
     *
     * If the embedder wants to cancel the streaming, they should make the next
     * GetMoreData call return 0. V8 will interpret it as end of data (and most
     * probably, parsing will fail). The streaming task will return as soon as
     * V8 has parsed the data it received so far.
     */
    virtual size_t GetMoreData(const uint8_t** src) = 0;
  };

  /**
   * Source code which can be streamed into V8 in pieces. It will be parsed
   * while streaming and compiled after parsing has completed. StreamedSource
   * must be kept alive while the streaming task is run (see ScriptStreamingTask
   * below).
   */
  class V8_EXPORT StreamedSource {
   public:
    enum Encoding { ONE_BYTE, TWO_BYTE, UTF8, WINDOWS_1252 };

    StreamedSource(std::unique_ptr<ExternalSourceStream> source_stream,
                   Encoding encoding);
    ~StreamedSource();

    internal::ScriptStreamingData* impl() const { return impl_.get(); }

    // Prevent copying.
    StreamedSource(const StreamedSource&) = delete;
    StreamedSource& operator=(const StreamedSource&) = delete;

    CompilationDetails& compilation_details() { return compilation_details_; }

   private:
    std::unique_ptr<internal::ScriptStreamingData> impl_;

    // V8 writes this data and never reads it. It exists only to be informative
    // to the embedder.
    CompilationDetails compilation_details_;
  };

  /**
   * A streaming task which the embedder must run on a background thread to
   * stream scripts into V8. Returned by ScriptCompiler::StartStreaming.
   */
  class V8_EXPORT ScriptStreamingTask final {
   public:
    void Run();

   private:
    friend class ScriptCompiler;

    explicit ScriptStreamingTask(internal::ScriptStreamingData* data)
        : data_(data) {}

    internal::ScriptStreamingData* data_;
  };

  /**
   * A task which the embedder must run on a background thread to
   * consume a V8 code cache. Returned by
   * ScriptCompiler::StartConsumingCodeCache.
   */
  class V8_EXPORT ConsumeCodeCacheTask final {
   public:
    ~ConsumeCodeCacheTask();

    void Run();

    /**
     * Provides the source text string and origin information to the consumption
     * task. May be called before, during, or after Run(). This step checks
     * whether the script matches an existing script in the Isolate's
     * compilation cache. To check whether such a script was found, call
     * ShouldMergeWithExistingScript.
     *
     * The Isolate provided must be the same one used during
     * StartConsumingCodeCache and must be currently entered on the thread that
     * calls this function. The source text and origin provided in this step
     * must precisely match those used later in the ScriptCompiler::Source that
     * will contain this ConsumeCodeCacheTask.
     */
    void SourceTextAvailable(Isolate* isolate, Local<String> source_text,
                             const ScriptOrigin& origin);

    /**
     * Returns whether the embedder should call MergeWithExistingScript. This
     * function may be called from any thread, any number of times, but its
     * return value is only meaningful after SourceTextAvailable has completed.
     */
    bool ShouldMergeWithExistingScript() const;

    /**
     * Merges newly deserialized data into an existing script which was found
     * during SourceTextAvailable. May be called only after Run() has completed.
     * Can execute on any thread, like Run().
     */
    void MergeWithExistingScript();

   private:
    friend class ScriptCompiler;

    explicit ConsumeCodeCacheTask(
        std::unique_ptr<internal::BackgroundDeserializeTask> impl);

    std::unique_ptr<internal::BackgroundDeserializeTask> impl_;
  };

  enum CompileOptions {
    kNoCompileOptions = 0,
    kConsumeCodeCache,
    kEagerCompile,
    kProduceCompileHints,
    kConsumeCompileHints
  };

  /**
   * The reason for which we are not requesting or providing a code cache.
   */
  enum NoCacheReason {
    kNoCacheNoReason = 0,
    kNoCacheBecauseCachingDisabled,
    kNoCacheBecauseNoResource,
    kNoCacheBecauseInlineScript,
    kNoCacheBecauseModule,
    kNoCacheBecauseStreamingSource,
    kNoCacheBecauseInspector,
    kNoCacheBecauseScriptTooSmall,
    kNoCacheBecauseCacheTooCold,
    kNoCacheBecauseV8Extension,
    kNoCacheBecauseExtensionModule,
    kNoCacheBecausePacScript,
    kNoCacheBecauseInDocumentWrite,
    kNoCacheBecauseResourceWithNoCacheHandler,
    kNoCacheBecauseDeferredProduceCodeCache
  };

  /**
   * Compiles the specified script (context-independent).
   * Cached data as part of the source object can be optionally produced to be
   * consumed later to speed up compilation of identical source scripts.
   *
   * Note that when producing cached data, the source must point to NULL for
   * cached data. When consuming cached data, the cached data must have been
   * produced by the same version of V8, and the embedder needs to ensure the
   * cached data is the correct one for the given script.
   *
   * \param source Script source code.
   * \return Compiled script object (context independent; for running it must be
   *   bound to a context).
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<UnboundScript> CompileUnboundScript(
      Isolate* isolate, Source* source,
      CompileOptions options = kNoCompileOptions,
      NoCacheReason no_cache_reason = kNoCacheNoReason);

  /**
   * Compiles the specified script (bound to current context).
   *
   * \param source Script source code.
   * \param pre_data Pre-parsing data, as obtained by ScriptData::PreCompile()
   *   using pre_data speeds compilation if it's done multiple times.
   *   Owned by caller, no references are kept when this function returns.
   * \return Compiled script object, bound to the context that was active
   *   when this function was called. When run it will always use this
   *   context.
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<Script> Compile(
      Local<Context> context, Source* source,
      CompileOptions options = kNoCompileOptions,
      NoCacheReason no_cache_reason = kNoCacheNoReason);

  /**
   * Returns a task which streams script data into V8, or NULL if the script
   * cannot be streamed. The user is responsible for running the task on a
   * background thread and deleting it. When ran, the task starts parsing the
   * script, and it will request data from the StreamedSource as needed. When
   * ScriptStreamingTask::Run exits, all data has been streamed and the script
   * can be compiled (see Compile below).
   *
   * This API allows to start the streaming with as little data as possible, and
   * the remaining data (for example, the ScriptOrigin) is passed to Compile.
   */
  static ScriptStreamingTask* StartStreaming(
      Isolate* isolate, StreamedSource* source,
      ScriptType type = ScriptType::kClassic,
      CompileOptions options = kNoCompileOptions,
      CompileHintCallback compile_hint_callback = nullptr,
      void* compile_hint_callback_data = nullptr);

  static ConsumeCodeCacheTask* StartConsumingCodeCache(
      Isolate* isolate, std::unique_ptr<CachedData> source);

  /**
   * Compiles a streamed script (bound to current context).
   *
   * This can only be called after the streaming has finished
   * (ScriptStreamingTask has been run). V8 doesn't construct the source string
   * during streaming, so the embedder needs to pass the full source here.
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<Script> Compile(
      Local<Context> context, StreamedSource* source,
      Local<String> full_source_string, const ScriptOrigin& origin);

  /**
   * Return a version tag for CachedData for the current V8 version & flags.
   *
   * This value is meant only for determining whether a previously generated
   * CachedData instance is still valid; the tag has no other meaing.
   *
   * Background: The data carried by CachedData may depend on the exact
   *   V8 version number or current compiler flags. This means that when
   *   persisting CachedData, the embedder must take care to not pass in
   *   data from another V8 version, or the same version with different
   *   features enabled.
   *
   *   The easiest way to do so is to clear the embedder's cache on any
   *   such change.
   *
   *   Alternatively, this tag can be stored alongside the cached data and
   *   compared when it is being used.
   */
  static uint32_t CachedDataVersionTag();

  /**
   * Compile an ES module, returning a Module that encapsulates
   * the compiled code.
   *
   * Corresponds to the ParseModule abstract operation in the
   * ECMAScript specification.
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<Module> CompileModule(
      Isolate* isolate, Source* source,
      CompileOptions options = kNoCompileOptions,
      NoCacheReason no_cache_reason = kNoCacheNoReason);

  /**
   * Compiles a streamed module script.
   *
   * This can only be called after the streaming has finished
   * (ScriptStreamingTask has been run). V8 doesn't construct the source string
   * during streaming, so the embedder needs to pass the full source here.
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<Module> CompileModule(
      Local<Context> context, StreamedSource* v8_source,
      Local<String> full_source_string, const ScriptOrigin& origin);

  /**
   * Compile a function for a given context. This is equivalent to running
   *
   * with (obj) {
   *   return function(args) { ... }
   * }
   *
   * It is possible to specify multiple context extensions (obj in the above
   * example).
   */
  V8_DEPRECATED("Use CompileFunction")
  static V8_WARN_UNUSED_RESULT MaybeLocal<Function> CompileFunctionInContext(
      Local<Context> context, Source* source, size_t arguments_count,
      Local<String> arguments[], size_t context_extension_count,
      Local<Object> context_extensions[],
      CompileOptions options = kNoCompileOptions,
      NoCacheReason no_cache_reason = kNoCacheNoReason,
      Local<ScriptOrModule>* script_or_module_out = nullptr);

  static V8_WARN_UNUSED_RESULT MaybeLocal<Function> CompileFunction(
      Local<Context> context, Source* source, size_t arguments_count = 0,
      Local<String> arguments[] = nullptr, size_t context_extension_count = 0,
      Local<Object> context_extensions[] = nullptr,
      CompileOptions options = kNoCompileOptions,
      NoCacheReason no_cache_reason = kNoCacheNoReason);

  /**
   * Creates and returns code cache for the specified unbound_script.
   * This will return nullptr if the script cannot be serialized. The
   * CachedData returned by this function should be owned by the caller.
   */
  static CachedData* CreateCodeCache(Local<UnboundScript> unbound_script);

  /**
   * Creates and returns code cache for the specified unbound_module_script.
   * This will return nullptr if the script cannot be serialized. The
   * CachedData returned by this function should be owned by the caller.
   */
  static CachedData* CreateCodeCache(
      Local<UnboundModuleScript> unbound_module_script);

  /**
   * Creates and returns code cache for the specified function that was
   * previously produced by CompileFunction.
   * This will return nullptr if the script cannot be serialized. The
   * CachedData returned by this function should be owned by the caller.
   */
  static CachedData* CreateCodeCacheForFunction(Local<Function> function);

 private:
  static V8_WARN_UNUSED_RESULT MaybeLocal<UnboundScript> CompileUnboundInternal(
      Isolate* isolate, Source* source, CompileOptions options,
      NoCacheReason no_cache_reason);

  static V8_WARN_UNUSED_RESULT MaybeLocal<Function> CompileFunctionInternal(
      Local<Context> context, Source* source, size_t arguments_count,
      Local<String> arguments[], size_t context_extension_count,
      Local<Object> context_extensions[], CompileOptions options,
      NoCacheReason no_cache_reason,
      Local<ScriptOrModule>* script_or_module_out);
};

ScriptCompiler::Source::Source(Local<String> string, const ScriptOrigin& origin,
                               CachedData* data,
                               ConsumeCodeCacheTask* consume_cache_task)
    : source_string(string),
      resource_name(origin.ResourceName()),
      resource_line_offset(origin.LineOffset()),
      resource_column_offset(origin.ColumnOffset()),
      resource_options(origin.Options()),
      source_map_url(origin.SourceMapUrl()),
      host_defined_options(origin.GetHostDefinedOptions()),
      cached_data(data),
      consume_cache_task(consume_cache_task) {}

ScriptCompiler::Source::Source(Local<String> string, CachedData* data,
                               ConsumeCodeCacheTask* consume_cache_task)
    : source_string(string),
      cached_data(data),
      consume_cache_task(consume_cache_task) {}

ScriptCompiler::Source::Source(Local<String> string, const ScriptOrigin& origin,
                               CompileHintCallback callback,
                               void* callback_data)
    : source_string(string),
      resource_name(origin.ResourceName()),
      resource_line_offset(origin.LineOffset()),
      resource_column_offset(origin.ColumnOffset()),
      resource_options(origin.Options()),
      source_map_url(origin.SourceMapUrl()),
      host_defined_options(origin.GetHostDefinedOptions()),
      compile_hint_callback(callback),
      compile_hint_callback_data(callback_data) {}

const ScriptCompiler::CachedData* ScriptCompiler::Source::GetCachedData()
    const {
  return cached_data.get();
}

const ScriptOriginOptions& ScriptCompiler::Source::GetResourceOptions() const {
  return resource_options;
}

const ScriptCompiler::CompilationDetails&
ScriptCompiler::Source::GetCompilationDetails() const {
  return compilation_details;
}

ModuleRequest* ModuleRequest::Cast(Data* data) {
#ifdef V8_ENABLE_CHECKS
  CheckCast(data);
#endif
  return reinterpret_cast<ModuleRequest*>(data);
}

Module* Module::Cast(Data* data) {
#ifdef V8_ENABLE_CHECKS
  CheckCast(data);
#endif
  return reinterpret_cast<Module*>(data);
}

}  // namespace v8

#endif  // INCLUDE_V8_SCRIPT_H_
