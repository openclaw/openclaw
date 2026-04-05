// Copyright 2013 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef V8_V8_PLATFORM_H_
#define V8_V8_PLATFORM_H_

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>  // For abort.

#include <memory>
#include <string>

#include "v8-source-location.h"  // NOLINT(build/include_directory)
#include "v8config.h"  // NOLINT(build/include_directory)

namespace v8 {

class Isolate;

// Valid priorities supported by the task scheduling infrastructure.
enum class TaskPriority : uint8_t {
  /**
   * Best effort tasks are not critical for performance of the application. The
   * platform implementation should preempt such tasks if higher priority tasks
   * arrive.
   */
  kBestEffort,
  /**
   * User visible tasks are long running background tasks that will
   * improve performance and memory usage of the application upon completion.
   * Example: background compilation and garbage collection.
   */
  kUserVisible,
  /**
   * User blocking tasks are highest priority tasks that block the execution
   * thread (e.g. major garbage collection). They must be finished as soon as
   * possible.
   */
  kUserBlocking,
  kMaxPriority = kUserBlocking
};

/**
 * A Task represents a unit of work.
 */
class Task {
 public:
  virtual ~Task() = default;

  virtual void Run() = 0;
};

/**
 * An IdleTask represents a unit of work to be performed in idle time.
 * The Run method is invoked with an argument that specifies the deadline in
 * seconds returned by MonotonicallyIncreasingTime().
 * The idle task is expected to complete by this deadline.
 */
class IdleTask {
 public:
  virtual ~IdleTask() = default;
  virtual void Run(double deadline_in_seconds) = 0;
};

/**
 * A TaskRunner allows scheduling of tasks. The TaskRunner may still be used to
 * post tasks after the isolate gets destructed, but these tasks may not get
 * executed anymore. All tasks posted to a given TaskRunner will be invoked in
 * sequence. Tasks can be posted from any thread.
 */
class TaskRunner {
 public:
  /**
   * Schedules a task to be invoked by this TaskRunner. The TaskRunner
   * implementation takes ownership of |task|.
   *
   * Embedders should override PostTaskImpl instead of this.
   */
  virtual void PostTask(std::unique_ptr<Task> task) {
    PostTaskImpl(std::move(task), SourceLocation::Current());
  }

  /**
   * Schedules a task to be invoked by this TaskRunner. The TaskRunner
   * implementation takes ownership of |task|. The |task| cannot be nested
   * within other task executions.
   *
   * Tasks which shouldn't be interleaved with JS execution must be posted with
   * |PostNonNestableTask| or |PostNonNestableDelayedTask|. This is because the
   * embedder may process tasks in a callback which is called during JS
   * execution.
   *
   * In particular, tasks which execute JS must be non-nestable, since JS
   * execution is not allowed to nest.
   *
   * Requires that |TaskRunner::NonNestableTasksEnabled()| is true.
   *
   * Embedders should override PostNonNestableTaskImpl instead of this.
   */
  virtual void PostNonNestableTask(std::unique_ptr<Task> task) {
    PostNonNestableTaskImpl(std::move(task), SourceLocation::Current());
  }

  /**
   * Schedules a task to be invoked by this TaskRunner. The task is scheduled
   * after the given number of seconds |delay_in_seconds|. The TaskRunner
   * implementation takes ownership of |task|.
   *
   * Embedders should override PostDelayedTaskImpl instead of this.
   */
  virtual void PostDelayedTask(std::unique_ptr<Task> task,
                               double delay_in_seconds) {
    PostDelayedTaskImpl(std::move(task), delay_in_seconds,
                        SourceLocation::Current());
  }

  /**
   * Schedules a task to be invoked by this TaskRunner. The task is scheduled
   * after the given number of seconds |delay_in_seconds|. The TaskRunner
   * implementation takes ownership of |task|. The |task| cannot be nested
   * within other task executions.
   *
   * Tasks which shouldn't be interleaved with JS execution must be posted with
   * |PostNonNestableTask| or |PostNonNestableDelayedTask|. This is because the
   * embedder may process tasks in a callback which is called during JS
   * execution.
   *
   * In particular, tasks which execute JS must be non-nestable, since JS
   * execution is not allowed to nest.
   *
   * Requires that |TaskRunner::NonNestableDelayedTasksEnabled()| is true.
   *
   * Embedders should override PostNonNestableDelayedTaskImpl instead of this.
   */
  virtual void PostNonNestableDelayedTask(std::unique_ptr<Task> task,
                                          double delay_in_seconds) {
    PostNonNestableDelayedTaskImpl(std::move(task), delay_in_seconds,
                                   SourceLocation::Current());
  }

  /**
   * Schedules an idle task to be invoked by this TaskRunner. The task is
   * scheduled when the embedder is idle. Requires that
   * |TaskRunner::IdleTasksEnabled()| is true. Idle tasks may be reordered
   * relative to other task types and may be starved for an arbitrarily long
   * time if no idle time is available. The TaskRunner implementation takes
   * ownership of |task|.
   *
   * Embedders should override PostIdleTaskImpl instead of this.
   */
  virtual void PostIdleTask(std::unique_ptr<IdleTask> task) {
    PostIdleTaskImpl(std::move(task), SourceLocation::Current());
  }

  /**
   * Returns true if idle tasks are enabled for this TaskRunner.
   */
  virtual bool IdleTasksEnabled() = 0;

  /**
   * Returns true if non-nestable tasks are enabled for this TaskRunner.
   */
  virtual bool NonNestableTasksEnabled() const { return false; }

  /**
   * Returns true if non-nestable delayed tasks are enabled for this TaskRunner.
   */
  virtual bool NonNestableDelayedTasksEnabled() const { return false; }

  TaskRunner() = default;
  virtual ~TaskRunner() = default;

  TaskRunner(const TaskRunner&) = delete;
  TaskRunner& operator=(const TaskRunner&) = delete;

 protected:
  /**
   * Implementation of above methods with an additional `location` argument.
   */
  virtual void PostTaskImpl(std::unique_ptr<Task> task,
                            const SourceLocation& location) {}
  virtual void PostNonNestableTaskImpl(std::unique_ptr<Task> task,
                                       const SourceLocation& location) {}
  virtual void PostDelayedTaskImpl(std::unique_ptr<Task> task,
                                   double delay_in_seconds,
                                   const SourceLocation& location) {}
  virtual void PostNonNestableDelayedTaskImpl(std::unique_ptr<Task> task,
                                              double delay_in_seconds,
                                              const SourceLocation& location) {}
  virtual void PostIdleTaskImpl(std::unique_ptr<IdleTask> task,
                                const SourceLocation& location) {}
};

/**
 * Delegate that's passed to Job's worker task, providing an entry point to
 * communicate with the scheduler.
 */
class JobDelegate {
 public:
  /**
   * Returns true if this thread *must* return from the worker task on the
   * current thread ASAP. Workers should periodically invoke ShouldYield (or
   * YieldIfNeeded()) as often as is reasonable.
   * After this method returned true, ShouldYield must not be called again.
   */
  virtual bool ShouldYield() = 0;

  /**
   * Notifies the scheduler that max concurrency was increased, and the number
   * of worker should be adjusted accordingly. See Platform::PostJob() for more
   * details.
   */
  virtual void NotifyConcurrencyIncrease() = 0;

  /**
   * Returns a task_id unique among threads currently running this job, such
   * that GetTaskId() < worker count. To achieve this, the same task_id may be
   * reused by a different thread after a worker_task returns.
   */
  virtual uint8_t GetTaskId() = 0;

  /**
   * Returns true if the current task is called from the thread currently
   * running JobHandle::Join().
   */
  virtual bool IsJoiningThread() const = 0;
};

/**
 * Handle returned when posting a Job. Provides methods to control execution of
 * the posted Job.
 */
class JobHandle {
 public:
  virtual ~JobHandle() = default;

  /**
   * Notifies the scheduler that max concurrency was increased, and the number
   * of worker should be adjusted accordingly. See Platform::PostJob() for more
   * details.
   */
  virtual void NotifyConcurrencyIncrease() = 0;

  /**
   * Contributes to the job on this thread. Doesn't return until all tasks have
   * completed and max concurrency becomes 0. When Join() is called and max
   * concurrency reaches 0, it should not increase again. This also promotes
   * this Job's priority to be at least as high as the calling thread's
   * priority.
   */
  virtual void Join() = 0;

  /**
   * Forces all existing workers to yield ASAP. Waits until they have all
   * returned from the Job's callback before returning.
   */
  virtual void Cancel() = 0;

  /*
   * Forces all existing workers to yield ASAP but doesn’t wait for them.
   * Warning, this is dangerous if the Job's callback is bound to or has access
   * to state which may be deleted after this call.
   */
  virtual void CancelAndDetach() = 0;

  /**
   * Returns true if there's any work pending or any worker running.
   */
  virtual bool IsActive() = 0;

  /**
   * Returns true if associated with a Job and other methods may be called.
   * Returns false after Join() or Cancel() was called. This may return true
   * even if no workers are running and IsCompleted() returns true
   */
  virtual bool IsValid() = 0;

  /**
   * Returns true if job priority can be changed.
   */
  virtual bool UpdatePriorityEnabled() const { return false; }

  /**
   *  Update this Job's priority.
   */
  virtual void UpdatePriority(TaskPriority new_priority) {}
};

/**
 * A JobTask represents work to run in parallel from Platform::PostJob().
 */
class JobTask {
 public:
  virtual ~JobTask() = default;

  virtual void Run(JobDelegate* delegate) = 0;

  /**
   * Controls the maximum number of threads calling Run() concurrently, given
   * the number of threads currently assigned to this job and executing Run().
   * Run() is only invoked if the number of threads previously running Run() was
   * less than the value returned. In general, this should return the latest
   * number of incomplete work items (smallest unit of work) left to process,
   * including items that are currently in progress. |worker_count| is the
   * number of threads currently assigned to this job which some callers may
   * need to determine their return value. Since GetMaxConcurrency() is a leaf
   * function, it must not call back any JobHandle methods.
   */
  virtual size_t GetMaxConcurrency(size_t worker_count) const = 0;
};

/**
 * A "blocking call" refers to any call that causes the calling thread to wait
 * off-CPU. It includes but is not limited to calls that wait on synchronous
 * file I/O operations: read or write a file from disk, interact with a pipe or
 * a socket, rename or delete a file, enumerate files in a directory, etc.
 * Acquiring a low contention lock is not considered a blocking call.
 */

/**
 * BlockingType indicates the likelihood that a blocking call will actually
 * block.
 */
enum class BlockingType {
  // The call might block (e.g. file I/O that might hit in memory cache).
  kMayBlock,
  // The call will definitely block (e.g. cache already checked and now pinging
  // server synchronously).
  kWillBlock
};

/**
 * This class is instantiated with CreateBlockingScope() in every scope where a
 * blocking call is made and serves as a precise annotation of the scope that
 * may/will block. May be implemented by an embedder to adjust the thread count.
 * CPU usage should be minimal within that scope. ScopedBlockingCalls can be
 * nested.
 */
class ScopedBlockingCall {
 public:
  virtual ~ScopedBlockingCall() = default;
};

/**
 * The interface represents complex arguments to trace events.
 */
class ConvertableToTraceFormat {
 public:
  virtual ~ConvertableToTraceFormat() = default;

  /**
   * Append the class info to the provided |out| string. The appended
   * data must be a valid JSON object. Strings must be properly quoted, and
   * escaped. There is no processing applied to the content after it is
   * appended.
   */
  virtual void AppendAsTraceFormat(std::string* out) const = 0;
};

/**
 * V8 Tracing controller.
 *
 * Can be implemented by an embedder to record trace events from V8.
 *
 * Will become obsolete in Perfetto SDK build (v8_use_perfetto = true).
 */
class TracingController {
 public:
  virtual ~TracingController() = default;

  // In Perfetto mode, trace events are written using Perfetto's Track Event
  // API directly without going through the embedder. However, it is still
  // possible to observe tracing being enabled and disabled.
#if !defined(V8_USE_PERFETTO)
  /**
   * Called by TRACE_EVENT* macros, don't call this directly.
   * The name parameter is a category group for example:
   * TRACE_EVENT0("v8,parse", "V8.Parse")
   * The pointer returned points to a value with zero or more of the bits
   * defined in CategoryGroupEnabledFlags.
   **/
  virtual const uint8_t* GetCategoryGroupEnabled(const char* name) {
    static uint8_t no = 0;
    return &no;
  }

  /**
   * Adds a trace event to the platform tracing system. These function calls are
   * usually the result of a TRACE_* macro from trace_event_common.h when
   * tracing and the category of the particular trace are enabled. It is not
   * advisable to call these functions on their own; they are really only meant
   * to be used by the trace macros. The returned handle can be used by
   * UpdateTraceEventDuration to update the duration of COMPLETE events.
   */
  virtual uint64_t AddTraceEvent(
      char phase, const uint8_t* category_enabled_flag, const char* name,
      const char* scope, uint64_t id, uint64_t bind_id, int32_t num_args,
      const char** arg_names, const uint8_t* arg_types,
      const uint64_t* arg_values,
      std::unique_ptr<ConvertableToTraceFormat>* arg_convertables,
      unsigned int flags) {
    return 0;
  }
  virtual uint64_t AddTraceEventWithTimestamp(
      char phase, const uint8_t* category_enabled_flag, const char* name,
      const char* scope, uint64_t id, uint64_t bind_id, int32_t num_args,
      const char** arg_names, const uint8_t* arg_types,
      const uint64_t* arg_values,
      std::unique_ptr<ConvertableToTraceFormat>* arg_convertables,
      unsigned int flags, int64_t timestamp) {
    return 0;
  }

  /**
   * Sets the duration field of a COMPLETE trace event. It must be called with
   * the handle returned from AddTraceEvent().
   **/
  virtual void UpdateTraceEventDuration(const uint8_t* category_enabled_flag,
                                        const char* name, uint64_t handle) {}
#endif  // !defined(V8_USE_PERFETTO)

  class TraceStateObserver {
   public:
    virtual ~TraceStateObserver() = default;
    virtual void OnTraceEnabled() = 0;
    virtual void OnTraceDisabled() = 0;
  };

  /**
   * Adds tracing state change observer.
   * Does nothing in Perfetto SDK build (v8_use_perfetto = true).
   */
  virtual void AddTraceStateObserver(TraceStateObserver*) {}

  /**
   * Removes tracing state change observer.
   * Does nothing in Perfetto SDK build (v8_use_perfetto = true).
   */
  virtual void RemoveTraceStateObserver(TraceStateObserver*) {}
};

/**
 * A V8 memory page allocator.
 *
 * Can be implemented by an embedder to manage large host OS allocations.
 */
class PageAllocator {
 public:
  virtual ~PageAllocator() = default;

  /**
   * Gets the page granularity for AllocatePages and FreePages. Addresses and
   * lengths for those calls should be multiples of AllocatePageSize().
   */
  virtual size_t AllocatePageSize() = 0;

  /**
   * Gets the page granularity for SetPermissions and ReleasePages. Addresses
   * and lengths for those calls should be multiples of CommitPageSize().
   */
  virtual size_t CommitPageSize() = 0;

  /**
   * Sets the random seed so that GetRandomMmapAddr() will generate repeatable
   * sequences of random mmap addresses.
   */
  virtual void SetRandomMmapSeed(int64_t seed) = 0;

  /**
   * Returns a randomized address, suitable for memory allocation under ASLR.
   * The address will be aligned to AllocatePageSize.
   */
  virtual void* GetRandomMmapAddr() = 0;

  /**
   * Memory permissions.
   */
  enum Permission {
    kNoAccess,
    kRead,
    kReadWrite,
    kReadWriteExecute,
    kReadExecute,
    // Set this when reserving memory that will later require kReadWriteExecute
    // permissions. The resulting behavior is platform-specific, currently
    // this is used to set the MAP_JIT flag on Apple Silicon.
    // TODO(jkummerow): Remove this when Wasm has a platform-independent
    // w^x implementation.
    // TODO(saelo): Remove this once all JIT pages are allocated through the
    // VirtualAddressSpace API.
    kNoAccessWillJitLater
  };

  /**
   * Allocates memory in range with the given alignment and permission.
   */
  virtual void* AllocatePages(void* address, size_t length, size_t alignment,
                              Permission permissions) = 0;

  /**
   * Frees memory in a range that was allocated by a call to AllocatePages.
   */
  virtual bool FreePages(void* address, size_t length) = 0;

  /**
   * Releases memory in a range that was allocated by a call to AllocatePages.
   */
  virtual bool ReleasePages(void* address, size_t length,
                            size_t new_length) = 0;

  /**
   * Sets permissions on pages in an allocated range.
   */
  virtual bool SetPermissions(void* address, size_t length,
                              Permission permissions) = 0;

  /**
   * Recommits discarded pages in the given range with given permissions.
   * Discarded pages must be recommitted with their original permissions
   * before they are used again.
   */
  virtual bool RecommitPages(void* address, size_t length,
                             Permission permissions) {
    // TODO(v8:12797): make it pure once it's implemented on Chromium side.
    return false;
  }

  /**
   * Frees memory in the given [address, address + size) range. address and size
   * should be operating system page-aligned. The next write to this
   * memory area brings the memory transparently back. This should be treated as
   * a hint to the OS that the pages are no longer needed. It does not guarantee
   * that the pages will be discarded immediately or at all.
   */
  virtual bool DiscardSystemPages(void* address, size_t size) { return true; }

  /**
   * Decommits any wired memory pages in the given range, allowing the OS to
   * reclaim them, and marks the region as inacessible (kNoAccess). The address
   * range stays reserved and can be accessed again later by changing its
   * permissions. However, in that case the memory content is guaranteed to be
   * zero-initialized again. The memory must have been previously allocated by a
   * call to AllocatePages. Returns true on success, false otherwise.
   */
  virtual bool DecommitPages(void* address, size_t size) = 0;

  /**
   * INTERNAL ONLY: This interface has not been stabilised and may change
   * without notice from one release to another without being deprecated first.
   */
  class SharedMemoryMapping {
   public:
    // Implementations are expected to free the shared memory mapping in the
    // destructor.
    virtual ~SharedMemoryMapping() = default;
    virtual void* GetMemory() const = 0;
  };

  /**
   * INTERNAL ONLY: This interface has not been stabilised and may change
   * without notice from one release to another without being deprecated first.
   */
  class SharedMemory {
   public:
    // Implementations are expected to free the shared memory in the destructor.
    virtual ~SharedMemory() = default;
    virtual std::unique_ptr<SharedMemoryMapping> RemapTo(
        void* new_address) const = 0;
    virtual void* GetMemory() const = 0;
    virtual size_t GetSize() const = 0;
  };

  /**
   * INTERNAL ONLY: This interface has not been stabilised and may change
   * without notice from one release to another without being deprecated first.
   *
   * Reserve pages at a fixed address returning whether the reservation is
   * possible. The reserved memory is detached from the PageAllocator and so
   * should not be freed by it. It's intended for use with
   * SharedMemory::RemapTo, where ~SharedMemoryMapping would free the memory.
   */
  virtual bool ReserveForSharedMemoryMapping(void* address, size_t size) {
    return false;
  }

  /**
   * INTERNAL ONLY: This interface has not been stabilised and may change
   * without notice from one release to another without being deprecated first.
   *
   * Allocates shared memory pages. Not all PageAllocators need support this and
   * so this method need not be overridden.
   * Allocates a new read-only shared memory region of size |length| and copies
   * the memory at |original_address| into it.
   */
  virtual std::unique_ptr<SharedMemory> AllocateSharedPages(
      size_t length, const void* original_address) {
    return {};
  }

  /**
   * INTERNAL ONLY: This interface has not been stabilised and may change
   * without notice from one release to another without being deprecated first.
   *
   * If not overridden and changed to return true, V8 will not attempt to call
   * AllocateSharedPages or RemapSharedPages. If overridden, AllocateSharedPages
   * and RemapSharedPages must also be overridden.
   */
  virtual bool CanAllocateSharedPages() { return false; }
};

/**
 * An allocator that uses per-thread permissions to protect the memory.
 *
 * The implementation is platform/hardware specific, e.g. using pkeys on x64.
 *
 * INTERNAL ONLY: This interface has not been stabilised and may change
 * without notice from one release to another without being deprecated first.
 */
class ThreadIsolatedAllocator {
 public:
  virtual ~ThreadIsolatedAllocator() = default;

  virtual void* Allocate(size_t size) = 0;

  virtual void Free(void* object) = 0;

  enum class Type {
    kPkey,
  };

  virtual Type Type() const = 0;

  /**
   * Return the pkey used to implement the thread isolation if Type == kPkey.
   */
  virtual int Pkey() const { return -1; }

  /**
   * Per-thread permissions can be reset on signal handler entry. Even reading
   * ThreadIsolated memory will segfault in that case.
   * Call this function on signal handler entry to ensure that read permissions
   * are restored.
   */
  static void SetDefaultPermissionsForSignalHandler();
};

// Opaque type representing a handle to a shared memory region.
using PlatformSharedMemoryHandle = intptr_t;
static constexpr PlatformSharedMemoryHandle kInvalidSharedMemoryHandle = -1;

// Conversion routines from the platform-dependent shared memory identifiers
// into the opaque PlatformSharedMemoryHandle type. These use the underlying
// types (e.g. unsigned int) instead of the typedef'd ones (e.g. mach_port_t)
// to avoid pulling in large OS header files into this header file. Instead,
// the users of these routines are expected to include the respecitve OS
// headers in addition to this one.
#if V8_OS_DARWIN
// Convert between a shared memory handle and a mach_port_t referencing a memory
// entry object.
inline PlatformSharedMemoryHandle SharedMemoryHandleFromMachMemoryEntry(
    unsigned int port) {
  return static_cast<PlatformSharedMemoryHandle>(port);
}
inline unsigned int MachMemoryEntryFromSharedMemoryHandle(
    PlatformSharedMemoryHandle handle) {
  return static_cast<unsigned int>(handle);
}
#elif V8_OS_FUCHSIA
// Convert between a shared memory handle and a zx_handle_t to a VMO.
inline PlatformSharedMemoryHandle SharedMemoryHandleFromVMO(uint32_t handle) {
  return static_cast<PlatformSharedMemoryHandle>(handle);
}
inline uint32_t VMOFromSharedMemoryHandle(PlatformSharedMemoryHandle handle) {
  return static_cast<uint32_t>(handle);
}
#elif V8_OS_WIN
// Convert between a shared memory handle and a Windows HANDLE to a file mapping
// object.
inline PlatformSharedMemoryHandle SharedMemoryHandleFromFileMapping(
    void* handle) {
  return reinterpret_cast<PlatformSharedMemoryHandle>(handle);
}
inline void* FileMappingFromSharedMemoryHandle(
    PlatformSharedMemoryHandle handle) {
  return reinterpret_cast<void*>(handle);
}
#else
// Convert between a shared memory handle and a file descriptor.
inline PlatformSharedMemoryHandle SharedMemoryHandleFromFileDescriptor(int fd) {
  return static_cast<PlatformSharedMemoryHandle>(fd);
}
inline int FileDescriptorFromSharedMemoryHandle(
    PlatformSharedMemoryHandle handle) {
  return static_cast<int>(handle);
}
#endif

/**
 * Possible permissions for memory pages.
 */
enum class PagePermissions {
  kNoAccess,
  kRead,
  kReadWrite,
  kReadWriteExecute,
  kReadExecute,
};

/**
 * Class to manage a virtual memory address space.
 *
 * This class represents a contiguous region of virtual address space in which
 * sub-spaces and (private or shared) memory pages can be allocated, freed, and
 * modified. This interface is meant to eventually replace the PageAllocator
 * interface, and can be used as an alternative in the meantime.
 *
 * This API is not yet stable and may change without notice!
 */
class VirtualAddressSpace {
 public:
  using Address = uintptr_t;

  VirtualAddressSpace(size_t page_size, size_t allocation_granularity,
                      Address base, size_t size,
                      PagePermissions max_page_permissions)
      : page_size_(page_size),
        allocation_granularity_(allocation_granularity),
        base_(base),
        size_(size),
        max_page_permissions_(max_page_permissions) {}

  virtual ~VirtualAddressSpace() = default;

  /**
   * The page size used inside this space. Guaranteed to be a power of two.
   * Used as granularity for all page-related operations except for allocation,
   * which use the allocation_granularity(), see below.
   *
   * \returns the page size in bytes.
   */
  size_t page_size() const { return page_size_; }

  /**
   * The granularity of page allocations and, by extension, of subspace
   * allocations. This is guaranteed to be a power of two and a multiple of the
   * page_size(). In practice, this is equal to the page size on most OSes, but
   * on Windows it is usually 64KB, while the page size is 4KB.
   *
   * \returns the allocation granularity in bytes.
   */
  size_t allocation_granularity() const { return allocation_granularity_; }

  /**
   * The base address of the address space managed by this instance.
   *
   * \returns the base address of this address space.
   */
  Address base() const { return base_; }

  /**
   * The size of the address space managed by this instance.
   *
   * \returns the size of this address space in bytes.
   */
  size_t size() const { return size_; }

  /**
   * The maximum page permissions that pages allocated inside this space can
   * obtain.
   *
   * \returns the maximum page permissions.
   */
  PagePermissions max_page_permissions() const { return max_page_permissions_; }

  /**
   * Whether the |address| is inside the address space managed by this instance.
   *
   * \returns true if it is inside the address space, false if not.
   */
  bool Contains(Address address) const {
    return (address >= base()) && (address < base() + size());
  }

  /**
   * Sets the random seed so that GetRandomPageAddress() will generate
   * repeatable sequences of random addresses.
   *
   * \param The seed for the PRNG.
   */
  virtual void SetRandomSeed(int64_t seed) = 0;

  /**
   * Returns a random address inside this address space, suitable for page
   * allocations hints.
   *
   * \returns a random address aligned to allocation_granularity().
   */
  virtual Address RandomPageAddress() = 0;

  /**
   * Allocates private memory pages with the given alignment and permissions.
   *
   * \param hint If nonzero, the allocation is attempted to be placed at the
   * given address first. If that fails, the allocation is attempted to be
   * placed elsewhere, possibly nearby, but that is not guaranteed. Specifying
   * zero for the hint always causes this function to choose a random address.
   * The hint, if specified, must be aligned to the specified alignment.
   *
   * \param size The size of the allocation in bytes. Must be a multiple of the
   * allocation_granularity().
   *
   * \param alignment The alignment of the allocation in bytes. Must be a
   * multiple of the allocation_granularity() and should be a power of two.
   *
   * \param permissions The page permissions of the newly allocated pages.
   *
   * \returns the start address of the allocated pages on success, zero on
   * failure.
   */
  static constexpr Address kNoHint = 0;
  virtual V8_WARN_UNUSED_RESULT Address
  AllocatePages(Address hint, size_t size, size_t alignment,
                PagePermissions permissions) = 0;

  /**
   * Frees previously allocated pages.
   *
   * This function will terminate the process on failure as this implies a bug
   * in the client. As such, there is no return value.
   *
   * \param address The start address of the pages to free. This address must
   * have been obtained through a call to AllocatePages.
   *
   * \param size The size in bytes of the region to free. This must match the
   * size passed to AllocatePages when the pages were allocated.
   */
  virtual void FreePages(Address address, size_t size) = 0;

  /**
   * Sets permissions of all allocated pages in the given range.
   *
   * This operation can fail due to OOM, in which case false is returned. If
   * the operation fails for a reason other than OOM, this function will
   * terminate the process as this implies a bug in the client.
   *
   * \param address The start address of the range. Must be aligned to
   * page_size().
   *
   * \param size The size in bytes of the range. Must be a multiple
   * of page_size().
   *
   * \param permissions The new permissions for the range.
   *
   * \returns true on success, false on OOM.
   */
  virtual V8_WARN_UNUSED_RESULT bool SetPagePermissions(
      Address address, size_t size, PagePermissions permissions) = 0;

  /**
   * Creates a guard region at the specified address.
   *
   * Guard regions are guaranteed to cause a fault when accessed and generally
   * do not count towards any memory consumption limits. Further, allocating
   * guard regions can usually not fail in subspaces if the region does not
   * overlap with another region, subspace, or page allocation.
   *
   * \param address The start address of the guard region. Must be aligned to
   * the allocation_granularity().
   *
   * \param size The size of the guard region in bytes. Must be a multiple of
   * the allocation_granularity().
   *
   * \returns true on success, false otherwise.
   */
  virtual V8_WARN_UNUSED_RESULT bool AllocateGuardRegion(Address address,
                                                         size_t size) = 0;

  /**
   * Frees an existing guard region.
   *
   * This function will terminate the process on failure as this implies a bug
   * in the client. As such, there is no return value.
   *
   * \param address The start address of the guard region to free. This address
   * must have previously been used as address parameter in a successful
   * invocation of AllocateGuardRegion.
   *
   * \param size The size in bytes of the guard region to free. This must match
   * the size passed to AllocateGuardRegion when the region was created.
   */
  virtual void FreeGuardRegion(Address address, size_t size) = 0;

  /**
   * Allocates shared memory pages with the given permissions.
   *
   * \param hint Placement hint. See AllocatePages.
   *
   * \param size The size of the allocation in bytes. Must be a multiple of the
   * allocation_granularity().
   *
   * \param permissions The page permissions of the newly allocated pages.
   *
   * \param handle A platform-specific handle to a shared memory object. See
   * the SharedMemoryHandleFromX routines above for ways to obtain these.
   *
   * \param offset The offset in the shared memory object at which the mapping
   * should start. Must be a multiple of the allocation_granularity().
   *
   * \returns the start address of the allocated pages on success, zero on
   * failure.
   */
  virtual V8_WARN_UNUSED_RESULT Address
  AllocateSharedPages(Address hint, size_t size, PagePermissions permissions,
                      PlatformSharedMemoryHandle handle, uint64_t offset) = 0;

  /**
   * Frees previously allocated shared pages.
   *
   * This function will terminate the process on failure as this implies a bug
   * in the client. As such, there is no return value.
   *
   * \param address The start address of the pages to free. This address must
   * have been obtained through a call to AllocateSharedPages.
   *
   * \param size The size in bytes of the region to free. This must match the
   * size passed to AllocateSharedPages when the pages were allocated.
   */
  virtual void FreeSharedPages(Address address, size_t size) = 0;

  /**
   * Whether this instance can allocate subspaces or not.
   *
   * \returns true if subspaces can be allocated, false if not.
   */
  virtual bool CanAllocateSubspaces() = 0;

  /*
   * Allocate a subspace.
   *
   * The address space of a subspace stays reserved in the parent space for the
   * lifetime of the subspace. As such, it is guaranteed that page allocations
   * on the parent space cannot end up inside a subspace.
   *
   * \param hint Hints where the subspace should be allocated. See
   * AllocatePages() for more details.
   *
   * \param size The size in bytes of the subspace. Must be a multiple of the
   * allocation_granularity().
   *
   * \param alignment The alignment of the subspace in bytes. Must be a multiple
   * of the allocation_granularity() and should be a power of two.
   *
   * \param max_page_permissions The maximum permissions that pages allocated in
   * the subspace can obtain.
   *
   * \returns a new subspace or nullptr on failure.
   */
  virtual std::unique_ptr<VirtualAddressSpace> AllocateSubspace(
      Address hint, size_t size, size_t alignment,
      PagePermissions max_page_permissions) = 0;

  //
  // TODO(v8) maybe refactor the methods below before stabilizing the API. For
  // example by combining them into some form of page operation method that
  // takes a command enum as parameter.
  //

  /**
   * Recommits discarded pages in the given range with given permissions.
   * Discarded pages must be recommitted with their original permissions
   * before they are used again.
   *
   * \param address The start address of the range. Must be aligned to
   * page_size().
   *
   * \param size The size in bytes of the range. Must be a multiple
   * of page_size().
   *
   * \param permissions The permissions for the range that the pages must have.
   *
   * \returns true on success, false otherwise.
   */
  virtual V8_WARN_UNUSED_RESULT bool RecommitPages(
      Address address, size_t size, PagePermissions permissions) = 0;

  /**
   * Frees memory in the given [address, address + size) range. address and
   * size should be aligned to the page_size(). The next write to this memory
   * area brings the memory transparently back. This should be treated as a
   * hint to the OS that the pages are no longer needed. It does not guarantee
   * that the pages will be discarded immediately or at all.
   *
   * \returns true on success, false otherwise. Since this method is only a
   * hint, a successful invocation does not imply that pages have been removed.
   */
  virtual V8_WARN_UNUSED_RESULT bool DiscardSystemPages(Address address,
                                                        size_t size) {
    return true;
  }
  /**
   * Decommits any wired memory pages in the given range, allowing the OS to
   * reclaim them, and marks the region as inacessible (kNoAccess). The address
   * range stays reserved and can be accessed again later by changing its
   * permissions. However, in that case the memory content is guaranteed to be
   * zero-initialized again. The memory must have been previously allocated by a
   * call to AllocatePages.
   *
   * \returns true on success, false otherwise.
   */
  virtual V8_WARN_UNUSED_RESULT bool DecommitPages(Address address,
                                                   size_t size) = 0;

 private:
  const size_t page_size_;
  const size_t allocation_granularity_;
  const Address base_;
  const size_t size_;
  const PagePermissions max_page_permissions_;
};

/**
 * V8 Allocator used for allocating zone backings.
 */
class ZoneBackingAllocator {
 public:
  using MallocFn = void* (*)(size_t);
  using FreeFn = void (*)(void*);

  virtual MallocFn GetMallocFn() const { return ::malloc; }
  virtual FreeFn GetFreeFn() const { return ::free; }
};

/**
 * Observer used by V8 to notify the embedder about entering/leaving sections
 * with high throughput of malloc/free operations.
 */
class HighAllocationThroughputObserver {
 public:
  virtual void EnterSection() {}
  virtual void LeaveSection() {}
};

/**
 * V8 Platform abstraction layer.
 *
 * The embedder has to provide an implementation of this interface before
 * initializing the rest of V8.
 */
class Platform {
 public:
  virtual ~Platform() = default;

  /**
   * Allows the embedder to manage memory page allocations.
   * Returning nullptr will cause V8 to use the default page allocator.
   */
  virtual PageAllocator* GetPageAllocator() = 0;

  /**
   * Allows the embedder to provide an allocator that uses per-thread memory
   * permissions to protect allocations.
   * Returning nullptr will cause V8 to disable protections that rely on this
   * feature.
   */
  virtual ThreadIsolatedAllocator* GetThreadIsolatedAllocator() {
    return nullptr;
  }

  /**
   * Allows the embedder to specify a custom allocator used for zones.
   */
  virtual ZoneBackingAllocator* GetZoneBackingAllocator() {
    static ZoneBackingAllocator default_allocator;
    return &default_allocator;
  }

  /**
   * Enables the embedder to respond in cases where V8 can't allocate large
   * blocks of memory. V8 retries the failed allocation once after calling this
   * method. On success, execution continues; otherwise V8 exits with a fatal
   * error.
   * Embedder overrides of this function must NOT call back into V8.
   */
  virtual void OnCriticalMemoryPressure() {}

  /**
   * Gets the max number of worker threads that may be used to execute
   * concurrent work scheduled for any single TaskPriority by
   * Call(BlockingTask)OnWorkerThread() or PostJob(). This can be used to
   * estimate the number of tasks a work package should be split into. A return
   * value of 0 means that there are no worker threads available. Note that a
   * value of 0 won't prohibit V8 from posting tasks using |CallOnWorkerThread|.
   */
  virtual int NumberOfWorkerThreads() = 0;

  /**
   * Returns a TaskRunner which can be used to post a task on the foreground.
   * The TaskRunner's NonNestableTasksEnabled() must be true. This function
   * should only be called from a foreground thread.
   * TODO(chromium:1448758): Deprecate once |GetForegroundTaskRunner(Isolate*,
   * TaskPriority)| is ready.
   */
  virtual std::shared_ptr<v8::TaskRunner> GetForegroundTaskRunner(
      Isolate* isolate) {
    return GetForegroundTaskRunner(isolate, TaskPriority::kUserBlocking);
  }

  /**
   * Returns a TaskRunner with a specific |priority| which can be used to post a
   * task on the foreground thread. The TaskRunner's NonNestableTasksEnabled()
   * must be true. This function should only be called from a foreground thread.
   * TODO(chromium:1448758): Make pure virtual once embedders implement it.
   */
  virtual std::shared_ptr<v8::TaskRunner> GetForegroundTaskRunner(
      Isolate* isolate, TaskPriority priority) {
    return nullptr;
  }

  /**
   * Schedules a task to be invoked on a worker thread.
   * Embedders should override PostTaskOnWorkerThreadImpl() instead of
   * CallOnWorkerThread().
   */
  void CallOnWorkerThread(
      std::unique_ptr<Task> task,
      const SourceLocation& location = SourceLocation::Current()) {
    PostTaskOnWorkerThreadImpl(TaskPriority::kUserVisible, std::move(task),
                               location);
  }

  /**
   * Schedules a task that blocks the main thread to be invoked with
   * high-priority on a worker thread.
   * Embedders should override PostTaskOnWorkerThreadImpl() instead of
   * CallBlockingTaskOnWorkerThread().
   */
  void CallBlockingTaskOnWorkerThread(
      std::unique_ptr<Task> task,
      const SourceLocation& location = SourceLocation::Current()) {
    // Embedders may optionally override this to process these tasks in a high
    // priority pool.
    PostTaskOnWorkerThreadImpl(TaskPriority::kUserBlocking, std::move(task),
                               location);
  }

  /**
   * Schedules a task to be invoked with low-priority on a worker thread.
   * Embedders should override PostTaskOnWorkerThreadImpl() instead of
   * CallLowPriorityTaskOnWorkerThread().
   */
  void CallLowPriorityTaskOnWorkerThread(
      std::unique_ptr<Task> task,
      const SourceLocation& location = SourceLocation::Current()) {
    // Embedders may optionally override this to process these tasks in a low
    // priority pool.
    PostTaskOnWorkerThreadImpl(TaskPriority::kBestEffort, std::move(task),
                               location);
  }

  /**
   * Schedules a task to be invoked on a worker thread after |delay_in_seconds|
   * expires.
   * Embedders should override PostDelayedTaskOnWorkerThreadImpl() instead of
   * CallDelayedOnWorkerThread().
   */
  void CallDelayedOnWorkerThread(
      std::unique_ptr<Task> task, double delay_in_seconds,
      const SourceLocation& location = SourceLocation::Current()) {
    PostDelayedTaskOnWorkerThreadImpl(TaskPriority::kUserVisible,
                                      std::move(task), delay_in_seconds,
                                      location);
  }

  /**
   * Returns true if idle tasks are enabled for the given |isolate|.
   */
  virtual bool IdleTasksEnabled(Isolate* isolate) { return false; }

  /**
   * Posts |job_task| to run in parallel. Returns a JobHandle associated with
   * the Job, which can be joined or canceled.
   * This avoids degenerate cases:
   * - Calling CallOnWorkerThread() for each work item, causing significant
   *   overhead.
   * - Fixed number of CallOnWorkerThread() calls that split the work and might
   *   run for a long time. This is problematic when many components post
   *   "num cores" tasks and all expect to use all the cores. In these cases,
   *   the scheduler lacks context to be fair to multiple same-priority requests
   *   and/or ability to request lower priority work to yield when high priority
   *   work comes in.
   * A canonical implementation of |job_task| looks like:
   * class MyJobTask : public JobTask {
   *  public:
   *   MyJobTask(...) : worker_queue_(...) {}
   *   // JobTask:
   *   void Run(JobDelegate* delegate) override {
   *     while (!delegate->ShouldYield()) {
   *       // Smallest unit of work.
   *       auto work_item = worker_queue_.TakeWorkItem(); // Thread safe.
   *       if (!work_item) return;
   *       ProcessWork(work_item);
   *     }
   *   }
   *
   *   size_t GetMaxConcurrency() const override {
   *     return worker_queue_.GetSize(); // Thread safe.
   *   }
   * };
   * auto handle = PostJob(TaskPriority::kUserVisible,
   *                       std::make_unique<MyJobTask>(...));
   * handle->Join();
   *
   * PostJob() and methods of the returned JobHandle/JobDelegate, must never be
   * called while holding a lock that could be acquired by JobTask::Run or
   * JobTask::GetMaxConcurrency -- that could result in a deadlock. This is
   * because [1] JobTask::GetMaxConcurrency may be invoked while holding
   * internal lock (A), hence JobTask::GetMaxConcurrency can only use a lock (B)
   * if that lock is *never* held while calling back into JobHandle from any
   * thread (A=>B/B=>A deadlock) and [2] JobTask::Run or
   * JobTask::GetMaxConcurrency may be invoked synchronously from JobHandle
   * (B=>JobHandle::foo=>B deadlock).
   * Embedders should override CreateJobImpl() instead of PostJob().
   */
  std::unique_ptr<JobHandle> PostJob(
      TaskPriority priority, std::unique_ptr<JobTask> job_task,
      const SourceLocation& location = SourceLocation::Current()) {
    auto handle = CreateJob(priority, std::move(job_task), location);
    handle->NotifyConcurrencyIncrease();
    return handle;
  }

  /**
   * Creates and returns a JobHandle associated with a Job. Unlike PostJob(),
   * this doesn't immediately schedules |worker_task| to run; the Job is then
   * scheduled by calling either NotifyConcurrencyIncrease() or Join().
   *
   * A sufficient CreateJob() implementation that uses the default Job provided
   * in libplatform looks like:
   *  std::unique_ptr<JobHandle> CreateJob(
   *      TaskPriority priority, std::unique_ptr<JobTask> job_task) override {
   *    return v8::platform::NewDefaultJobHandle(
   *        this, priority, std::move(job_task), NumberOfWorkerThreads());
   * }
   *
   * Embedders should override CreateJobImpl() instead of CreateJob().
   */
  std::unique_ptr<JobHandle> CreateJob(
      TaskPriority priority, std::unique_ptr<JobTask> job_task,
      const SourceLocation& location = SourceLocation::Current()) {
    return CreateJobImpl(priority, std::move(job_task), location);
  }

  /**
   * Instantiates a ScopedBlockingCall to annotate a scope that may/will block.
   */
  virtual std::unique_ptr<ScopedBlockingCall> CreateBlockingScope(
      BlockingType blocking_type) {
    return nullptr;
  }

  /**
   * Monotonically increasing time in seconds from an arbitrary fixed point in
   * the past. This function is expected to return at least
   * millisecond-precision values. For this reason,
   * it is recommended that the fixed point be no further in the past than
   * the epoch.
   **/
  virtual double MonotonicallyIncreasingTime() = 0;

  /**
   * Current wall-clock time in milliseconds since epoch. Use
   * CurrentClockTimeMillisHighResolution() when higher precision is
   * required.
   */
  virtual int64_t CurrentClockTimeMilliseconds() {
    return static_cast<int64_t>(floor(CurrentClockTimeMillis()));
  }

  /**
   * This function is deprecated and will be deleted. Use either
   * CurrentClockTimeMilliseconds() or
   * CurrentClockTimeMillisecondsHighResolution().
   */
  virtual double CurrentClockTimeMillis() = 0;

  /**
   * Same as CurrentClockTimeMilliseconds(), but with more precision.
   */
  virtual double CurrentClockTimeMillisecondsHighResolution() {
    return CurrentClockTimeMillis();
  }

  typedef void (*StackTracePrinter)();

  /**
   * Returns a function pointer that print a stack trace of the current stack
   * on invocation. Disables printing of the stack trace if nullptr.
   */
  virtual StackTracePrinter GetStackTracePrinter() { return nullptr; }

  /**
   * Returns an instance of a v8::TracingController. This must be non-nullptr.
   */
  virtual TracingController* GetTracingController() = 0;

  /**
   * Tells the embedder to generate and upload a crashdump during an unexpected
   * but non-critical scenario.
   */
  virtual void DumpWithoutCrashing() {}

  /**
   * Allows the embedder to observe sections with high throughput allocation
   * operations.
   */
  virtual HighAllocationThroughputObserver*
  GetHighAllocationThroughputObserver() {
    static HighAllocationThroughputObserver default_observer;
    return &default_observer;
  }

 protected:
  /**
   * Default implementation of current wall-clock time in milliseconds
   * since epoch. Useful for implementing |CurrentClockTimeMillis| if
   * nothing special needed.
   */
  V8_EXPORT static double SystemClockTimeMillis();

  /**
   * Creates and returns a JobHandle associated with a Job.
   */
  virtual std::unique_ptr<JobHandle> CreateJobImpl(
      TaskPriority priority, std::unique_ptr<JobTask> job_task,
      const SourceLocation& location) = 0;

  /**
   * Schedules a task with |priority| to be invoked on a worker thread.
   */
  virtual void PostTaskOnWorkerThreadImpl(TaskPriority priority,
                                          std::unique_ptr<Task> task,
                                          const SourceLocation& location) = 0;

  /**
   * Schedules a task with |priority| to be invoked on a worker thread after
   * |delay_in_seconds| expires.
   */
  virtual void PostDelayedTaskOnWorkerThreadImpl(
      TaskPriority priority, std::unique_ptr<Task> task,
      double delay_in_seconds, const SourceLocation& location) = 0;
};

}  // namespace v8

#endif  // V8_V8_PLATFORM_H_
