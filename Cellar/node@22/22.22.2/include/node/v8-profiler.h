// Copyright 2010 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef V8_V8_PROFILER_H_
#define V8_V8_PROFILER_H_

#include <limits.h>

#include <memory>
#include <unordered_set>
#include <vector>

#include "cppgc/common.h"          // NOLINT(build/include_directory)
#include "v8-local-handle.h"       // NOLINT(build/include_directory)
#include "v8-message.h"            // NOLINT(build/include_directory)
#include "v8-persistent-handle.h"  // NOLINT(build/include_directory)

/**
 * Profiler support for the V8 JavaScript engine.
 */
namespace v8 {

enum class EmbedderStateTag : uint8_t;
class HeapGraphNode;
struct HeapStatsUpdate;
class Object;
enum StateTag : uint16_t;

using NativeObject = void*;
using SnapshotObjectId = uint32_t;
using ProfilerId = uint32_t;

struct CpuProfileDeoptFrame {
  int script_id;
  size_t position;
};

namespace internal {
class CpuProfile;
}  // namespace internal

}  // namespace v8

#ifdef V8_OS_WIN
template class V8_EXPORT std::vector<v8::CpuProfileDeoptFrame>;
#endif

namespace v8 {

struct V8_EXPORT CpuProfileDeoptInfo {
  /** A pointer to a static string owned by v8. */
  const char* deopt_reason;
  std::vector<CpuProfileDeoptFrame> stack;
};

}  // namespace v8

#ifdef V8_OS_WIN
template class V8_EXPORT std::vector<v8::CpuProfileDeoptInfo>;
#endif

namespace v8 {

/**
 * CpuProfileNode represents a node in a call graph.
 */
class V8_EXPORT CpuProfileNode {
 public:
  struct LineTick {
    /** The 1-based number of the source line where the function originates. */
    int line;

    /** The count of samples associated with the source line. */
    unsigned int hit_count;
  };

  // An annotation hinting at the source of a CpuProfileNode.
  enum SourceType {
    // User-supplied script with associated resource information.
    kScript = 0,
    // Native scripts and provided builtins.
    kBuiltin = 1,
    // Callbacks into native code.
    kCallback = 2,
    // VM-internal functions or state.
    kInternal = 3,
    // A node that failed to symbolize.
    kUnresolved = 4,
  };

  /** Returns function name (empty string for anonymous functions.) */
  Local<String> GetFunctionName() const;

  /**
   * Returns function name (empty string for anonymous functions.)
   * The string ownership is *not* passed to the caller. It stays valid until
   * profile is deleted. The function is thread safe.
   */
  const char* GetFunctionNameStr() const;

  /** Returns id of the script where function is located. */
  int GetScriptId() const;

  /** Returns resource name for script from where the function originates. */
  Local<String> GetScriptResourceName() const;

  /**
   * Returns resource name for script from where the function originates.
   * The string ownership is *not* passed to the caller. It stays valid until
   * profile is deleted. The function is thread safe.
   */
  const char* GetScriptResourceNameStr() const;

  /**
   * Return true if the script from where the function originates is flagged as
   * being shared cross-origin.
   */
  bool IsScriptSharedCrossOrigin() const;

  /**
   * Returns the number, 1-based, of the line where the function originates.
   * kNoLineNumberInfo if no line number information is available.
   */
  int GetLineNumber() const;

  /**
   * Returns 1-based number of the column where the function originates.
   * kNoColumnNumberInfo if no column number information is available.
   */
  int GetColumnNumber() const;

  /**
   * Returns the number of the function's source lines that collect the samples.
   */
  unsigned int GetHitLineCount() const;

  /** Returns the set of source lines that collect the samples.
   *  The caller allocates buffer and responsible for releasing it.
   *  True if all available entries are copied, otherwise false.
   *  The function copies nothing if buffer is not large enough.
   */
  bool GetLineTicks(LineTick* entries, unsigned int length) const;

  /** Returns bailout reason for the function
    * if the optimization was disabled for it.
    */
  const char* GetBailoutReason() const;

  /**
    * Returns the count of samples where the function was currently executing.
    */
  unsigned GetHitCount() const;

  /** Returns id of the node. The id is unique within the tree */
  unsigned GetNodeId() const;

  /**
   * Gets the type of the source which the node was captured from.
   */
  SourceType GetSourceType() const;

  /** Returns child nodes count of the node. */
  int GetChildrenCount() const;

  /** Retrieves a child node by index. */
  const CpuProfileNode* GetChild(int index) const;

  /** Retrieves the ancestor node, or null if the root. */
  const CpuProfileNode* GetParent() const;

  /** Retrieves deopt infos for the node. */
  const std::vector<CpuProfileDeoptInfo>& GetDeoptInfos() const;

  static const int kNoLineNumberInfo = Message::kNoLineNumberInfo;
  static const int kNoColumnNumberInfo = Message::kNoColumnInfo;
};

/**
 * An interface for exporting data from V8, using "push" model.
 */
class V8_EXPORT OutputStream {
 public:
  enum WriteResult { kContinue = 0, kAbort = 1 };
  virtual ~OutputStream() = default;
  /** Notify about the end of stream. */
  virtual void EndOfStream() = 0;
  /** Get preferred output chunk size. Called only once. */
  virtual int GetChunkSize() { return 1024; }
  /**
   * Writes the next chunk of snapshot data into the stream. Writing
   * can be stopped by returning kAbort as function result. EndOfStream
   * will not be called in case writing was aborted.
   */
  virtual WriteResult WriteAsciiChunk(char* data, int size) = 0;
  /**
   * Writes the next chunk of heap stats data into the stream. Writing
   * can be stopped by returning kAbort as function result. EndOfStream
   * will not be called in case writing was aborted.
   */
  virtual WriteResult WriteHeapStatsChunk(HeapStatsUpdate* data, int count) {
    return kAbort;
  }
};

/**
 * CpuProfile contains a CPU profile in a form of top-down call tree
 * (from main() down to functions that do all the work).
 */
class V8_EXPORT CpuProfile {
 public:
  enum SerializationFormat {
    kJSON = 0  // See format description near 'Serialize' method.
  };
  /** Returns CPU profile title. */
  Local<String> GetTitle() const;

  /** Returns the root node of the top down call tree. */
  const CpuProfileNode* GetTopDownRoot() const;

  /**
   * Returns number of samples recorded. The samples are not recorded unless
   * |record_samples| parameter of CpuProfiler::StartCpuProfiling is true.
   */
  int GetSamplesCount() const;

  /**
   * Returns profile node corresponding to the top frame the sample at
   * the given index.
   */
  const CpuProfileNode* GetSample(int index) const;

  /**
   * Returns the timestamp of the sample. The timestamp is the number of
   * microseconds since some unspecified starting point.
   * The point is equal to the starting point used by GetStartTime.
   */
  int64_t GetSampleTimestamp(int index) const;

  /**
   * Returns time when the profile recording was started (in microseconds)
   * since some unspecified starting point.
   */
  int64_t GetStartTime() const;

  /**
   * Returns state of the vm when sample was captured.
   */
  StateTag GetSampleState(int index) const;

  /**
   * Returns state of the embedder when sample was captured.
   */
  EmbedderStateTag GetSampleEmbedderState(int index) const;

  /**
   * Returns time when the profile recording was stopped (in microseconds)
   * since some unspecified starting point.
   * The point is equal to the starting point used by GetStartTime.
   */
  int64_t GetEndTime() const;

  /**
   * Deletes the profile and removes it from CpuProfiler's list.
   * All pointers to nodes previously returned become invalid.
   */
  void Delete();

  /**
   * Prepare a serialized representation of the profile. The result
   * is written into the stream provided in chunks of specified size.
   *
   * For the JSON format, heap contents are represented as an object
   * with the following structure:
   *
   *  {
   *    nodes: [nodes array],
   *    startTime: number,
   *    endTime: number
   *    samples: [strings array]
   *    timeDeltas: [numbers array]
   *  }
   *
   */
  void Serialize(OutputStream* stream,
                 SerializationFormat format = kJSON) const;
};

enum CpuProfilingMode {
  // In the resulting CpuProfile tree, intermediate nodes in a stack trace
  // (from the root to a leaf) will have line numbers that point to the start
  // line of the function, rather than the line of the callsite of the child.
  kLeafNodeLineNumbers,
  // In the resulting CpuProfile tree, nodes are separated based on the line
  // number of their callsite in their parent.
  kCallerLineNumbers,
};

// Determines how names are derived for functions sampled.
enum CpuProfilingNamingMode {
  // Use the immediate name of functions at compilation time.
  kStandardNaming,
  // Use more verbose naming for functions without names, inferred from scope
  // where possible.
  kDebugNaming,
};

enum CpuProfilingLoggingMode {
  // Enables logging when a profile is active, and disables logging when all
  // profiles are detached.
  kLazyLogging,
  // Enables logging for the lifetime of the CpuProfiler. Calls to
  // StartRecording are faster, at the expense of runtime overhead.
  kEagerLogging,
};

// Enum for returning profiling status. Once StartProfiling is called,
// we want to return to clients whether the profiling was able to start
// correctly, or return a descriptive error.
enum class CpuProfilingStatus {
  kStarted,
  kAlreadyStarted,
  kErrorTooManyProfilers
};

/**
 * Result from StartProfiling returning the Profiling Status, and
 * id of the started profiler, or 0 if profiler is not started
 */
struct CpuProfilingResult {
  const ProfilerId id;
  const CpuProfilingStatus status;
};

/**
 * Delegate for when max samples reached and samples are discarded.
 */
class V8_EXPORT DiscardedSamplesDelegate {
 public:
  DiscardedSamplesDelegate() = default;

  virtual ~DiscardedSamplesDelegate() = default;
  virtual void Notify() = 0;

  ProfilerId GetId() const { return profiler_id_; }

 private:
  friend internal::CpuProfile;

  void SetId(ProfilerId id) { profiler_id_ = id; }

  ProfilerId profiler_id_;
};

/**
 * Optional profiling attributes.
 */
class V8_EXPORT CpuProfilingOptions {
 public:
  // Indicates that the sample buffer size should not be explicitly limited.
  static const unsigned kNoSampleLimit = UINT_MAX;

  /**
   * \param mode Type of computation of stack frame line numbers.
   * \param max_samples The maximum number of samples that should be recorded by
   *                    the profiler. Samples obtained after this limit will be
   *                    discarded.
   * \param sampling_interval_us controls the profile-specific target
   *                             sampling interval. The provided sampling
   *                             interval will be snapped to the next lowest
   *                             non-zero multiple of the profiler's sampling
   *                             interval, set via SetSamplingInterval(). If
   *                             zero, the sampling interval will be equal to
   *                             the profiler's sampling interval.
   * \param filter_context If specified, profiles will only contain frames
   *                       using this context. Other frames will be elided.
   */
  CpuProfilingOptions(
      CpuProfilingMode mode = kLeafNodeLineNumbers,
      unsigned max_samples = kNoSampleLimit, int sampling_interval_us = 0,
      MaybeLocal<Context> filter_context = MaybeLocal<Context>());

  CpuProfilingOptions(CpuProfilingOptions&&) = default;
  CpuProfilingOptions& operator=(CpuProfilingOptions&&) = default;

  CpuProfilingMode mode() const { return mode_; }
  unsigned max_samples() const { return max_samples_; }
  int sampling_interval_us() const { return sampling_interval_us_; }

 private:
  friend class internal::CpuProfile;

  bool has_filter_context() const { return !filter_context_.IsEmpty(); }
  void* raw_filter_context() const;

  CpuProfilingMode mode_;
  unsigned max_samples_;
  int sampling_interval_us_;
  Global<Context> filter_context_;
};

/**
 * Interface for controlling CPU profiling. Instance of the
 * profiler can be created using v8::CpuProfiler::New method.
 */
class V8_EXPORT CpuProfiler {
 public:
  /**
   * Creates a new CPU profiler for the |isolate|. The isolate must be
   * initialized. The profiler object must be disposed after use by calling
   * |Dispose| method.
   */
  static CpuProfiler* New(Isolate* isolate,
                          CpuProfilingNamingMode = kDebugNaming,
                          CpuProfilingLoggingMode = kLazyLogging);

  /**
   * Synchronously collect current stack sample in all profilers attached to
   * the |isolate|. The call does not affect number of ticks recorded for
   * the current top node.
   */
  static void CollectSample(Isolate* isolate);

  /**
   * Disposes the CPU profiler object.
   */
  void Dispose();

  /**
   * Changes default CPU profiler sampling interval to the specified number
   * of microseconds. Default interval is 1000us. This method must be called
   * when there are no profiles being recorded.
   */
  void SetSamplingInterval(int us);

  /**
   * Sets whether or not the profiler should prioritize consistency of sample
   * periodicity on Windows. Disabling this can greatly reduce CPU usage, but
   * may result in greater variance in sample timings from the platform's
   * scheduler. Defaults to enabled. This method must be called when there are
   * no profiles being recorded.
   */
  void SetUsePreciseSampling(bool);

  /**
   * Starts collecting a CPU profile. Several profiles may be collected at once.
   * Generates an anonymous profiler, without a String identifier.
   */
  CpuProfilingResult Start(
      CpuProfilingOptions options,
      std::unique_ptr<DiscardedSamplesDelegate> delegate = nullptr);

  /**
   * Starts collecting a CPU profile. Title may be an empty string. Several
   * profiles may be collected at once. Attempts to start collecting several
   * profiles with the same title are silently ignored.
   */
  CpuProfilingResult Start(
      Local<String> title, CpuProfilingOptions options,
      std::unique_ptr<DiscardedSamplesDelegate> delegate = nullptr);

  /**
   * Starts profiling with the same semantics as above, except with expanded
   * parameters.
   *
   * |record_samples| parameter controls whether individual samples should
   * be recorded in addition to the aggregated tree.
   *
   * |max_samples| controls the maximum number of samples that should be
   * recorded by the profiler. Samples obtained after this limit will be
   * discarded.
   */
  CpuProfilingResult Start(
      Local<String> title, CpuProfilingMode mode, bool record_samples = false,
      unsigned max_samples = CpuProfilingOptions::kNoSampleLimit);

  /**
   * The same as StartProfiling above, but the CpuProfilingMode defaults to
   * kLeafNodeLineNumbers mode, which was the previous default behavior of the
   * profiler.
   */
  CpuProfilingResult Start(Local<String> title, bool record_samples = false);

  /**
   * Starts collecting a CPU profile. Title may be an empty string. Several
   * profiles may be collected at once. Attempts to start collecting several
   * profiles with the same title are silently ignored.
   */
  CpuProfilingStatus StartProfiling(
      Local<String> title, CpuProfilingOptions options,
      std::unique_ptr<DiscardedSamplesDelegate> delegate = nullptr);

  /**
   * Starts profiling with the same semantics as above, except with expanded
   * parameters.
   *
   * |record_samples| parameter controls whether individual samples should
   * be recorded in addition to the aggregated tree.
   *
   * |max_samples| controls the maximum number of samples that should be
   * recorded by the profiler. Samples obtained after this limit will be
   * discarded.
   */
  CpuProfilingStatus StartProfiling(
      Local<String> title, CpuProfilingMode mode, bool record_samples = false,
      unsigned max_samples = CpuProfilingOptions::kNoSampleLimit);

  /**
   * The same as StartProfiling above, but the CpuProfilingMode defaults to
   * kLeafNodeLineNumbers mode, which was the previous default behavior of the
   * profiler.
   */
  CpuProfilingStatus StartProfiling(Local<String> title,
                                    bool record_samples = false);

  /**
   * Stops collecting CPU profile with a given id and returns it.
   */
  CpuProfile* Stop(ProfilerId id);

  /**
   * Stops collecting CPU profile with a given title and returns it.
   * If the title given is empty, finishes the last profile started.
   */
  CpuProfile* StopProfiling(Local<String> title);

  /**
   * Generate more detailed source positions to code objects. This results in
   * better results when mapping profiling samples to script source.
   */
  static void UseDetailedSourcePositionsForProfiling(Isolate* isolate);

 private:
  CpuProfiler();
  ~CpuProfiler();
  CpuProfiler(const CpuProfiler&);
  CpuProfiler& operator=(const CpuProfiler&);
};

/**
 * HeapSnapshotEdge represents a directed connection between heap
 * graph nodes: from retainers to retained nodes.
 */
class V8_EXPORT HeapGraphEdge {
 public:
  enum Type {
    kContextVariable = 0,  // A variable from a function context.
    kElement = 1,          // An element of an array.
    kProperty = 2,         // A named object property.
    kInternal = 3,         // A link that can't be accessed from JS,
                           // thus, its name isn't a real property name
                           // (e.g. parts of a ConsString).
    kHidden = 4,           // A link that is needed for proper sizes
                           // calculation, but may be hidden from user.
    kShortcut = 5,         // A link that must not be followed during
                           // sizes calculation.
    kWeak = 6              // A weak reference (ignored by the GC).
  };

  /** Returns edge type (see HeapGraphEdge::Type). */
  Type GetType() const;

  /**
   * Returns edge name. This can be a variable name, an element index, or
   * a property name.
   */
  Local<Value> GetName() const;

  /** Returns origin node. */
  const HeapGraphNode* GetFromNode() const;

  /** Returns destination node. */
  const HeapGraphNode* GetToNode() const;
};


/**
 * HeapGraphNode represents a node in a heap graph.
 */
class V8_EXPORT HeapGraphNode {
 public:
  enum Type {
    kHidden = 0,         // Hidden node, may be filtered when shown to user.
    kArray = 1,          // An array of elements.
    kString = 2,         // A string.
    kObject = 3,         // A JS object (except for arrays and strings).
    kCode = 4,           // Compiled code.
    kClosure = 5,        // Function closure.
    kRegExp = 6,         // RegExp.
    kHeapNumber = 7,     // Number stored in the heap.
    kNative = 8,         // Native object (not from V8 heap).
    kSynthetic = 9,      // Synthetic object, usually used for grouping
                         // snapshot items together.
    kConsString = 10,    // Concatenated string. A pair of pointers to strings.
    kSlicedString = 11,  // Sliced string. A fragment of another string.
    kSymbol = 12,        // A Symbol (ES6).
    kBigInt = 13,        // BigInt.
    kObjectShape = 14,   // Internal data used for tracking the shapes (or
                         // "hidden classes") of JS objects.
  };

  /** Returns node type (see HeapGraphNode::Type). */
  Type GetType() const;

  /**
   * Returns node name. Depending on node's type this can be the name
   * of the constructor (for objects), the name of the function (for
   * closures), string value, or an empty string (for compiled code).
   */
  Local<String> GetName() const;

  /**
   * Returns node id. For the same heap object, the id remains the same
   * across all snapshots.
   */
  SnapshotObjectId GetId() const;

  /** Returns node's own size, in bytes. */
  size_t GetShallowSize() const;

  /** Returns child nodes count of the node. */
  int GetChildrenCount() const;

  /** Retrieves a child by index. */
  const HeapGraphEdge* GetChild(int index) const;
};

/**
 * HeapSnapshots record the state of the JS heap at some moment.
 */
class V8_EXPORT HeapSnapshot {
 public:
  enum SerializationFormat {
    kJSON = 0  // See format description near 'Serialize' method.
  };

  /** Returns the root node of the heap graph. */
  const HeapGraphNode* GetRoot() const;

  /** Returns a node by its id. */
  const HeapGraphNode* GetNodeById(SnapshotObjectId id) const;

  /** Returns total nodes count in the snapshot. */
  int GetNodesCount() const;

  /** Returns a node by index. */
  const HeapGraphNode* GetNode(int index) const;

  /** Returns a max seen JS object Id. */
  SnapshotObjectId GetMaxSnapshotJSObjectId() const;

  /**
   * Deletes the snapshot and removes it from HeapProfiler's list.
   * All pointers to nodes, edges and paths previously returned become
   * invalid.
   */
  void Delete();

  /**
   * Prepare a serialized representation of the snapshot. The result
   * is written into the stream provided in chunks of specified size.
   * The total length of the serialized snapshot is unknown in
   * advance, it can be roughly equal to JS heap size (that means,
   * it can be really big - tens of megabytes).
   *
   * For the JSON format, heap contents are represented as an object
   * with the following structure:
   *
   *  {
   *    snapshot: {
   *      title: "...",
   *      uid: nnn,
   *      meta: { meta-info },
   *      node_count: nnn,
   *      edge_count: nnn
   *    },
   *    nodes: [nodes array],
   *    edges: [edges array],
   *    strings: [strings array]
   *  }
   *
   * Nodes reference strings, other nodes, and edges by their indexes
   * in corresponding arrays.
   */
  void Serialize(OutputStream* stream,
                 SerializationFormat format = kJSON) const;
};


/**
 * An interface for reporting progress and controlling long-running
 * activities.
 */
class V8_EXPORT ActivityControl {
 public:
  enum ControlOption {
    kContinue = 0,
    kAbort = 1
  };
  virtual ~ActivityControl() = default;
  /**
   * Notify about current progress. The activity can be stopped by
   * returning kAbort as the callback result.
   */
  virtual ControlOption ReportProgressValue(uint32_t done, uint32_t total) = 0;
};

/**
 * AllocationProfile is a sampled profile of allocations done by the program.
 * This is structured as a call-graph.
 */
class V8_EXPORT AllocationProfile {
 public:
  struct Allocation {
    /**
     * Size of the sampled allocation object.
     */
    size_t size;

    /**
     * The number of objects of such size that were sampled.
     */
    unsigned int count;
  };

  /**
   * Represents a node in the call-graph.
   */
  struct Node {
    /**
     * Name of the function. May be empty for anonymous functions or if the
     * script corresponding to this function has been unloaded.
     */
    Local<String> name;

    /**
     * Name of the script containing the function. May be empty if the script
     * name is not available, or if the script has been unloaded.
     */
    Local<String> script_name;

    /**
     * id of the script where the function is located. May be equal to
     * v8::UnboundScript::kNoScriptId in cases where the script doesn't exist.
     */
    int script_id;

    /**
     * Start position of the function in the script.
     */
    int start_position;

    /**
     * 1-indexed line number where the function starts. May be
     * kNoLineNumberInfo if no line number information is available.
     */
    int line_number;

    /**
     * 1-indexed column number where the function starts. May be
     * kNoColumnNumberInfo if no line number information is available.
     */
    int column_number;

    /**
     * Unique id of the node.
     */
    uint32_t node_id;

    /**
     * List of callees called from this node for which we have sampled
     * allocations. The lifetime of the children is scoped to the containing
     * AllocationProfile.
     */
    std::vector<Node*> children;

    /**
     * List of self allocations done by this node in the call-graph.
     */
    std::vector<Allocation> allocations;
  };

  /**
   * Represent a single sample recorded for an allocation.
   */
  struct Sample {
    /**
     * id of the node in the profile tree.
     */
    uint32_t node_id;

    /**
     * Size of the sampled allocation object.
     */
    size_t size;

    /**
     * The number of objects of such size that were sampled.
     */
    unsigned int count;

    /**
     * Unique time-ordered id of the allocation sample. Can be used to track
     * what samples were added or removed between two snapshots.
     */
    uint64_t sample_id;
  };

  /**
   * Returns the root node of the call-graph. The root node corresponds to an
   * empty JS call-stack. The lifetime of the returned Node* is scoped to the
   * containing AllocationProfile.
   */
  virtual Node* GetRootNode() = 0;
  virtual const std::vector<Sample>& GetSamples() = 0;

  virtual ~AllocationProfile() = default;

  static const int kNoLineNumberInfo = Message::kNoLineNumberInfo;
  static const int kNoColumnNumberInfo = Message::kNoColumnInfo;
};

/**
 * An object graph consisting of embedder objects and V8 objects.
 * Edges of the graph are strong references between the objects.
 * The embedder can build this graph during heap snapshot generation
 * to include the embedder objects in the heap snapshot.
 * Usage:
 * 1) Define derived class of EmbedderGraph::Node for embedder objects.
 * 2) Set the build embedder graph callback on the heap profiler using
 *    HeapProfiler::AddBuildEmbedderGraphCallback.
 * 3) In the callback use graph->AddEdge(node1, node2) to add an edge from
 *    node1 to node2.
 * 4) To represent references from/to V8 object, construct V8 nodes using
 *    graph->V8Node(value).
 */
class V8_EXPORT EmbedderGraph {
 public:
  class Node {
   public:
    /**
     * Detachedness specifies whether an object is attached or detached from the
     * main application state. While unkown in general, there may be objects
     * that specifically know their state. V8 passes this information along in
     * the snapshot. Users of the snapshot may use it to annotate the object
     * graph.
     */
    enum class Detachedness : uint8_t {
      kUnknown = 0,
      kAttached = 1,
      kDetached = 2,
    };

    Node() = default;
    virtual ~Node() = default;
    virtual const char* Name() = 0;
    virtual size_t SizeInBytes() = 0;
    /**
     * The corresponding V8 wrapper node if not null.
     * During heap snapshot generation the embedder node and the V8 wrapper
     * node will be merged into one node to simplify retaining paths.
     */
    virtual Node* WrapperNode() { return nullptr; }
    virtual bool IsRootNode() { return false; }
    /** Must return true for non-V8 nodes. */
    virtual bool IsEmbedderNode() { return true; }
    /**
     * Optional name prefix. It is used in Chrome for tagging detached nodes.
     */
    virtual const char* NamePrefix() { return nullptr; }

    /**
     * Returns the NativeObject that can be used for querying the
     * |HeapSnapshot|.
     */
    virtual NativeObject GetNativeObject() { return nullptr; }

    /**
     * Detachedness state of a given object. While unkown in general, there may
     * be objects that specifically know their state. V8 passes this information
     * along in the snapshot. Users of the snapshot may use it to annotate the
     * object graph.
     */
    virtual Detachedness GetDetachedness() { return Detachedness::kUnknown; }

    /**
     * Returns the address of the object in the embedder heap, or nullptr to not
     * specify the address. If this address is provided, then V8 can generate
     * consistent IDs for objects across subsequent heap snapshots, which allows
     * devtools to determine which objects were retained from one snapshot to
     * the next. This value is used only if GetNativeObject returns nullptr.
     */
    virtual const void* GetAddress() { return nullptr; }

    Node(const Node&) = delete;
    Node& operator=(const Node&) = delete;
  };

  /**
   * Returns a node corresponding to the given V8 value. Ownership is not
   * transferred. The result pointer is valid while the graph is alive.
   */
  virtual Node* V8Node(const v8::Local<v8::Value>& value) = 0;

  /**
   * Adds the given node to the graph and takes ownership of the node.
   * Returns a raw pointer to the node that is valid while the graph is alive.
   */
  virtual Node* AddNode(std::unique_ptr<Node> node) = 0;

  /**
   * Adds an edge that represents a strong reference from the given
   * node |from| to the given node |to|. The nodes must be added to the graph
   * before calling this function.
   *
   * If name is nullptr, the edge will have auto-increment indexes, otherwise
   * it will be named accordingly.
   */
  virtual void AddEdge(Node* from, Node* to, const char* name = nullptr) = 0;

  virtual ~EmbedderGraph() = default;
};

class QueryObjectPredicate {
 public:
  virtual ~QueryObjectPredicate() = default;
  virtual bool Filter(v8::Local<v8::Object> object) = 0;
};

/**
 * Interface for controlling heap profiling. Instance of the
 * profiler can be retrieved using v8::Isolate::GetHeapProfiler.
 */
class V8_EXPORT HeapProfiler {
 public:
  void QueryObjects(v8::Local<v8::Context> context,
                    QueryObjectPredicate* predicate,
                    std::vector<v8::Global<v8::Object>>* objects);

  enum SamplingFlags {
    kSamplingNoFlags = 0,
    kSamplingForceGC = 1 << 0,
    kSamplingIncludeObjectsCollectedByMajorGC = 1 << 1,
    kSamplingIncludeObjectsCollectedByMinorGC = 1 << 2,
  };

  /**
   * Callback function invoked during heap snapshot generation to retrieve
   * the embedder object graph. The callback should use graph->AddEdge(..) to
   * add references between the objects.
   * The callback must not trigger garbage collection in V8.
   */
  typedef void (*BuildEmbedderGraphCallback)(v8::Isolate* isolate,
                                             v8::EmbedderGraph* graph,
                                             void* data);

  /**
   * Callback function invoked during heap snapshot generation to retrieve
   * the detachedness state of an object referenced by a TracedReference.
   *
   * The callback takes Local<Value> as parameter to allow the embedder to
   * unpack the TracedReference into a Local and reuse that Local for different
   * purposes.
   */
  using GetDetachednessCallback = EmbedderGraph::Node::Detachedness (*)(
      v8::Isolate* isolate, const v8::Local<v8::Value>& v8_value,
      uint16_t class_id, void* data);

  /** Returns the number of snapshots taken. */
  int GetSnapshotCount();

  /** Returns a snapshot by index. */
  const HeapSnapshot* GetHeapSnapshot(int index);

  /**
   * Returns SnapshotObjectId for a heap object referenced by |value| if
   * it has been seen by the heap profiler, kUnknownObjectId otherwise.
   */
  SnapshotObjectId GetObjectId(Local<Value> value);

  /**
   * Returns SnapshotObjectId for a native object referenced by |value| if it
   * has been seen by the heap profiler, kUnknownObjectId otherwise.
   */
  SnapshotObjectId GetObjectId(NativeObject value);

  /**
   * Returns heap object with given SnapshotObjectId if the object is alive,
   * otherwise empty handle is returned.
   */
  Local<Value> FindObjectById(SnapshotObjectId id);

  /**
   * Clears internal map from SnapshotObjectId to heap object. The new objects
   * will not be added into it unless a heap snapshot is taken or heap object
   * tracking is kicked off.
   */
  void ClearObjectIds();

  /**
   * A constant for invalid SnapshotObjectId. GetSnapshotObjectId will return
   * it in case heap profiler cannot find id  for the object passed as
   * parameter. HeapSnapshot::GetNodeById will always return NULL for such id.
   */
  static const SnapshotObjectId kUnknownObjectId = 0;

  /**
   * Callback interface for retrieving user friendly names of global objects.
   */
  class ObjectNameResolver {
   public:
    /**
     * Returns name to be used in the heap snapshot for given node. Returned
     * string must stay alive until snapshot collection is completed.
     */
    virtual const char* GetName(Local<Object> object) = 0;

   protected:
    virtual ~ObjectNameResolver() = default;
  };

  enum class HeapSnapshotMode {
    /**
     * Heap snapshot for regular developers.
     */
    kRegular,
    /**
     * Heap snapshot is exposing internals that may be useful for experts.
     */
    kExposeInternals,
  };

  enum class NumericsMode {
    /**
     * Numeric values are hidden as they are values of the corresponding
     * objects.
     */
    kHideNumericValues,
    /**
     * Numeric values are exposed in artificial fields.
     */
    kExposeNumericValues
  };

  struct HeapSnapshotOptions final {
    // Manually define default constructor here to be able to use it in
    // `TakeSnapshot()` below.
    // NOLINTNEXTLINE
    HeapSnapshotOptions() {}

    /**
     * The control used to report intermediate progress to.
     */
    ActivityControl* control = nullptr;
    /**
     * The resolver used by the snapshot generator to get names for V8 objects.
     */
    ObjectNameResolver* global_object_name_resolver = nullptr;
    /**
     * Mode for taking the snapshot, see `HeapSnapshotMode`.
     */
    HeapSnapshotMode snapshot_mode = HeapSnapshotMode::kRegular;
    /**
     * Mode for dealing with numeric values, see `NumericsMode`.
     */
    NumericsMode numerics_mode = NumericsMode::kHideNumericValues;
    /**
     * Whether stack is considered as a root set.
     */
    cppgc::EmbedderStackState stack_state =
        cppgc::EmbedderStackState::kMayContainHeapPointers;
  };

  /**
   * Takes a heap snapshot.
   *
   * \returns the snapshot.
   */
  const HeapSnapshot* TakeHeapSnapshot(
      const HeapSnapshotOptions& options = HeapSnapshotOptions());

  /**
   * Takes a heap snapshot. See `HeapSnapshotOptions` for details on the
   * parameters.
   *
   * \returns the snapshot.
   */
  const HeapSnapshot* TakeHeapSnapshot(
      ActivityControl* control,
      ObjectNameResolver* global_object_name_resolver = nullptr,
      bool hide_internals = true, bool capture_numeric_value = false);

  /**
   * Starts tracking of heap objects population statistics. After calling
   * this method, all heap objects relocations done by the garbage collector
   * are being registered.
   *
   * |track_allocations| parameter controls whether stack trace of each
   * allocation in the heap will be recorded and reported as part of
   * HeapSnapshot.
   */
  void StartTrackingHeapObjects(bool track_allocations = false);

  /**
   * Adds a new time interval entry to the aggregated statistics array. The
   * time interval entry contains information on the current heap objects
   * population size. The method also updates aggregated statistics and
   * reports updates for all previous time intervals via the OutputStream
   * object. Updates on each time interval are provided as a stream of the
   * HeapStatsUpdate structure instances.
   * If |timestamp_us| is supplied, timestamp of the new entry will be written
   * into it. The return value of the function is the last seen heap object Id.
   *
   * StartTrackingHeapObjects must be called before the first call to this
   * method.
   */
  SnapshotObjectId GetHeapStats(OutputStream* stream,
                                int64_t* timestamp_us = nullptr);

  /**
   * Stops tracking of heap objects population statistics, cleans up all
   * collected data. StartHeapObjectsTracking must be called again prior to
   * calling GetHeapStats next time.
   */
  void StopTrackingHeapObjects();

  /**
   * Starts gathering a sampling heap profile. A sampling heap profile is
   * similar to tcmalloc's heap profiler and Go's mprof. It samples object
   * allocations and builds an online 'sampling' heap profile. At any point in
   * time, this profile is expected to be a representative sample of objects
   * currently live in the system. Each sampled allocation includes the stack
   * trace at the time of allocation, which makes this really useful for memory
   * leak detection.
   *
   * This mechanism is intended to be cheap enough that it can be used in
   * production with minimal performance overhead.
   *
   * Allocations are sampled using a randomized Poisson process. On average, one
   * allocation will be sampled every |sample_interval| bytes allocated. The
   * |stack_depth| parameter controls the maximum number of stack frames to be
   * captured on each allocation.
   *
   * NOTE: Support for native allocations doesn't exist yet, but is anticipated
   * in the future.
   *
   * Objects allocated before the sampling is started will not be included in
   * the profile.
   *
   * Returns false if a sampling heap profiler is already running.
   */
  bool StartSamplingHeapProfiler(uint64_t sample_interval = 512 * 1024,
                                 int stack_depth = 16,
                                 SamplingFlags flags = kSamplingNoFlags);

  /**
   * Stops the sampling heap profile and discards the current profile.
   */
  void StopSamplingHeapProfiler();

  /**
   * Returns the sampled profile of allocations allocated (and still live) since
   * StartSamplingHeapProfiler was called. The ownership of the pointer is
   * transferred to the caller. Returns nullptr if sampling heap profiler is not
   * active.
   */
  AllocationProfile* GetAllocationProfile();

  /**
   * Deletes all snapshots taken. All previously returned pointers to
   * snapshots and their contents become invalid after this call.
   */
  void DeleteAllHeapSnapshots();

  void AddBuildEmbedderGraphCallback(BuildEmbedderGraphCallback callback,
                                     void* data);
  void RemoveBuildEmbedderGraphCallback(BuildEmbedderGraphCallback callback,
                                        void* data);

  void SetGetDetachednessCallback(GetDetachednessCallback callback, void* data);

  /**
   * Default value of persistent handle class ID. Must not be used to
   * define a class. Can be used to reset a class of a persistent
   * handle.
   */
  static const uint16_t kPersistentHandleNoClassId = 0;

 private:
  HeapProfiler();
  ~HeapProfiler();
  HeapProfiler(const HeapProfiler&);
  HeapProfiler& operator=(const HeapProfiler&);
};

/**
 * A struct for exporting HeapStats data from V8, using "push" model.
 * See HeapProfiler::GetHeapStats.
 */
struct HeapStatsUpdate {
  HeapStatsUpdate(uint32_t index, uint32_t count, uint32_t size)
    : index(index), count(count), size(size) { }
  uint32_t index;  // Index of the time interval that was changed.
  uint32_t count;  // New value of count field for the interval with this index.
  uint32_t size;  // New value of size field for the interval with this index.
};

#define CODE_EVENTS_LIST(V)                          \
  V(Builtin)                                         \
  V(Callback)                                        \
  V(Eval)                                            \
  V(Function)                                        \
  V(InterpretedFunction)                             \
  V(Handler)                                         \
  V(BytecodeHandler)                                 \
  V(LazyCompile) /* Unused, use kFunction instead */ \
  V(RegExp)                                          \
  V(Script)                                          \
  V(Stub)                                            \
  V(Relocation)

/**
 * Note that this enum may be extended in the future. Please include a default
 * case if this enum is used in a switch statement.
 */
enum CodeEventType {
  kUnknownType = 0
#define V(Name) , k##Name##Type
  CODE_EVENTS_LIST(V)
#undef V
};

/**
 * Representation of a code creation event
 */
class V8_EXPORT CodeEvent {
 public:
  uintptr_t GetCodeStartAddress();
  size_t GetCodeSize();
  Local<String> GetFunctionName();
  Local<String> GetScriptName();
  int GetScriptLine();
  int GetScriptColumn();
  /**
   * NOTE (mmarchini): We can't allocate objects in the heap when we collect
   * existing code, and both the code type and the comment are not stored in the
   * heap, so we return those as const char*.
   */
  CodeEventType GetCodeType();
  const char* GetComment();

  static const char* GetCodeEventTypeName(CodeEventType code_event_type);

  uintptr_t GetPreviousCodeStartAddress();
};

/**
 * Interface to listen to code creation and code relocation events.
 */
class V8_EXPORT CodeEventHandler {
 public:
  /**
   * Creates a new listener for the |isolate|. The isolate must be initialized.
   * The listener object must be disposed after use by calling |Dispose| method.
   * Multiple listeners can be created for the same isolate.
   */
  explicit CodeEventHandler(Isolate* isolate);
  virtual ~CodeEventHandler();

  /**
   * Handle is called every time a code object is created or moved. Information
   * about each code event will be available through the `code_event`
   * parameter.
   *
   * When the CodeEventType is kRelocationType, the code for this CodeEvent has
   * moved from `GetPreviousCodeStartAddress()` to `GetCodeStartAddress()`.
   */
  virtual void Handle(CodeEvent* code_event) = 0;

  /**
   * Call `Enable()` to starts listening to code creation and code relocation
   * events. These events will be handled by `Handle()`.
   */
  void Enable();

  /**
   * Call `Disable()` to stop listening to code creation and code relocation
   * events.
   */
  void Disable();

 private:
  CodeEventHandler();
  CodeEventHandler(const CodeEventHandler&);
  CodeEventHandler& operator=(const CodeEventHandler&);
  void* internal_listener_;
};

}  // namespace v8


#endif  // V8_V8_PROFILER_H_
