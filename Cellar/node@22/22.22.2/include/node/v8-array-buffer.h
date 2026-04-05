// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_ARRAY_BUFFER_H_
#define INCLUDE_V8_ARRAY_BUFFER_H_

#include <stddef.h>

#include <memory>

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-object.h"        // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class SharedArrayBuffer;

#ifndef V8_ARRAY_BUFFER_INTERNAL_FIELD_COUNT
// The number of required internal fields can be defined by embedder.
#define V8_ARRAY_BUFFER_INTERNAL_FIELD_COUNT 2
#endif

enum class ArrayBufferCreationMode { kInternalized, kExternalized };

/**
 * A wrapper around the backing store (i.e. the raw memory) of an array buffer.
 * See a document linked in http://crbug.com/v8/9908 for more information.
 *
 * The allocation and destruction of backing stores is generally managed by
 * V8. Clients should always use standard C++ memory ownership types (i.e.
 * std::unique_ptr and std::shared_ptr) to manage lifetimes of backing stores
 * properly, since V8 internal objects may alias backing stores.
 *
 * This object does not keep the underlying |ArrayBuffer::Allocator| alive by
 * default. Use Isolate::CreateParams::array_buffer_allocator_shared when
 * creating the Isolate to make it hold a reference to the allocator itself.
 */
class V8_EXPORT BackingStore : public v8::internal::BackingStoreBase {
 public:
  ~BackingStore();

  /**
   * Return a pointer to the beginning of the memory block for this backing
   * store. The pointer is only valid as long as this backing store object
   * lives.
   */
  void* Data() const;

  /**
   * The length (in bytes) of this backing store.
   */
  size_t ByteLength() const;

  /**
   * The maximum length (in bytes) that this backing store may grow to.
   *
   * If this backing store was created for a resizable ArrayBuffer or a growable
   * SharedArrayBuffer, it is >= ByteLength(). Otherwise it is ==
   * ByteLength().
   */
  size_t MaxByteLength() const;

  /**
   * Indicates whether the backing store was created for an ArrayBuffer or
   * a SharedArrayBuffer.
   */
  bool IsShared() const;

  /**
   * Indicates whether the backing store was created for a resizable ArrayBuffer
   * or a growable SharedArrayBuffer, and thus may be resized by user JavaScript
   * code.
   */
  bool IsResizableByUserJavaScript() const;

  /**
   * Prevent implicit instantiation of operator delete with size_t argument.
   * The size_t argument would be incorrect because ptr points to the
   * internal BackingStore object.
   */
  void operator delete(void* ptr) { ::operator delete(ptr); }

  /**
   * Wrapper around ArrayBuffer::Allocator::Reallocate that preserves IsShared.
   * Assumes that the backing_store was allocated by the ArrayBuffer allocator
   * of the given isolate.
   */
  static std::unique_ptr<BackingStore> Reallocate(
      v8::Isolate* isolate, std::unique_ptr<BackingStore> backing_store,
      size_t byte_length);

  /**
   * This callback is used only if the memory block for a BackingStore cannot be
   * allocated with an ArrayBuffer::Allocator. In such cases the destructor of
   * the BackingStore invokes the callback to free the memory block.
   */
  using DeleterCallback = void (*)(void* data, size_t length,
                                   void* deleter_data);

  /**
   * If the memory block of a BackingStore is static or is managed manually,
   * then this empty deleter along with nullptr deleter_data can be passed to
   * ArrayBuffer::NewBackingStore to indicate that.
   *
   * The manually managed case should be used with caution and only when it
   * is guaranteed that the memory block freeing happens after detaching its
   * ArrayBuffer.
   */
  static void EmptyDeleter(void* data, size_t length, void* deleter_data);

 private:
  /**
   * See [Shared]ArrayBuffer::GetBackingStore and
   * [Shared]ArrayBuffer::NewBackingStore.
   */
  BackingStore();
};

#if !defined(V8_IMMINENT_DEPRECATION_WARNINGS)
// Use v8::BackingStore::DeleterCallback instead.
using BackingStoreDeleterCallback = void (*)(void* data, size_t length,
                                             void* deleter_data);

#endif

/**
 * An instance of the built-in ArrayBuffer constructor (ES6 draft 15.13.5).
 */
class V8_EXPORT ArrayBuffer : public Object {
 public:
  /**
   * A thread-safe allocator that V8 uses to allocate |ArrayBuffer|'s memory.
   * The allocator is a global V8 setting. It has to be set via
   * Isolate::CreateParams.
   *
   * Memory allocated through this allocator by V8 is accounted for as external
   * memory by V8. Note that V8 keeps track of the memory for all internalized
   * |ArrayBuffer|s. Responsibility for tracking external memory (using
   * Isolate::AdjustAmountOfExternalAllocatedMemory) is handed over to the
   * embedder upon externalization and taken over upon internalization (creating
   * an internalized buffer from an existing buffer).
   *
   * Note that it is unsafe to call back into V8 from any of the allocator
   * functions.
   */
  class V8_EXPORT Allocator {
   public:
    virtual ~Allocator() = default;

    /**
     * Allocate |length| bytes. Return nullptr if allocation is not successful.
     * Memory should be initialized to zeroes.
     */
    virtual void* Allocate(size_t length) = 0;

    /**
     * Allocate |length| bytes. Return nullptr if allocation is not successful.
     * Memory does not have to be initialized.
     */
    virtual void* AllocateUninitialized(size_t length) = 0;

    /**
     * Free the memory block of size |length|, pointed to by |data|.
     * That memory is guaranteed to be previously allocated by |Allocate|.
     */
    virtual void Free(void* data, size_t length) = 0;

    /**
     * Reallocate the memory block of size |old_length| to a memory block of
     * size |new_length| by expanding, contracting, or copying the existing
     * memory block. If |new_length| > |old_length|, then the new part of
     * the memory must be initialized to zeros. Return nullptr if reallocation
     * is not successful.
     *
     * The caller guarantees that the memory block was previously allocated
     * using Allocate or AllocateUninitialized.
     *
     * The default implementation allocates a new block and copies data.
     */
    virtual void* Reallocate(void* data, size_t old_length, size_t new_length);

    /**
     * ArrayBuffer allocation mode. kNormal is a malloc/free style allocation,
     * while kReservation is for larger allocations with the ability to set
     * access permissions.
     */
    enum class AllocationMode { kNormal, kReservation };

    /**
     * Convenience allocator.
     *
     * When the sandbox is enabled, this allocator will allocate its backing
     * memory inside the sandbox. Otherwise, it will rely on malloc/free.
     *
     * Caller takes ownership, i.e. the returned object needs to be freed using
     * |delete allocator| once it is no longer in use.
     */
    static Allocator* NewDefaultAllocator();
  };

  /**
   * Data length in bytes.
   */
  size_t ByteLength() const;

  /**
   * Maximum length in bytes.
   */
  size_t MaxByteLength() const;

  /**
   * Create a new ArrayBuffer. Allocate |byte_length| bytes.
   * Allocated memory will be owned by a created ArrayBuffer and
   * will be deallocated when it is garbage-collected,
   * unless the object is externalized.
   */
  static Local<ArrayBuffer> New(Isolate* isolate, size_t byte_length);

  /**
   * Create a new ArrayBuffer with an existing backing store.
   * The created array keeps a reference to the backing store until the array
   * is garbage collected. Note that the IsExternal bit does not affect this
   * reference from the array to the backing store.
   *
   * In future IsExternal bit will be removed. Until then the bit is set as
   * follows. If the backing store does not own the underlying buffer, then
   * the array is created in externalized state. Otherwise, the array is created
   * in internalized state. In the latter case the array can be transitioned
   * to the externalized state using Externalize(backing_store).
   */
  static Local<ArrayBuffer> New(Isolate* isolate,
                                std::shared_ptr<BackingStore> backing_store);

  /**
   * Returns a new standalone BackingStore that is allocated using the array
   * buffer allocator of the isolate. The result can be later passed to
   * ArrayBuffer::New.
   *
   * If the allocator returns nullptr, then the function may cause GCs in the
   * given isolate and re-try the allocation. If GCs do not help, then the
   * function will crash with an out-of-memory error.
   */
  static std::unique_ptr<BackingStore> NewBackingStore(Isolate* isolate,
                                                       size_t byte_length);
  /**
   * Returns a new standalone BackingStore with uninitialized memory and
   * return nullptr on failure.
   * This variant is for not breaking ABI on Node.js LTS. DO NOT USE.
   */
  static std::unique_ptr<BackingStore> NewBackingStoreForNodeLTS(
      Isolate* isolate, size_t byte_length);
  /**
   * Returns a new standalone BackingStore that takes over the ownership of
   * the given buffer. The destructor of the BackingStore invokes the given
   * deleter callback.
   *
   * The result can be later passed to ArrayBuffer::New. The raw pointer
   * to the buffer must not be passed again to any V8 API function.
   */
  static std::unique_ptr<BackingStore> NewBackingStore(
      void* data, size_t byte_length, v8::BackingStore::DeleterCallback deleter,
      void* deleter_data);

  /**
   * Returns a new resizable standalone BackingStore that is allocated using the
   * array buffer allocator of the isolate. The result can be later passed to
   * ArrayBuffer::New.
   *
   * |byte_length| must be <= |max_byte_length|.
   *
   * This function is usable without an isolate. Unlike |NewBackingStore| calls
   * with an isolate, GCs cannot be triggered, and there are no
   * retries. Allocation failure will cause the function to crash with an
   * out-of-memory error.
   */
  static std::unique_ptr<BackingStore> NewResizableBackingStore(
      size_t byte_length, size_t max_byte_length);

  /**
   * Returns true if this ArrayBuffer may be detached.
   */
  bool IsDetachable() const;

  /**
   * Returns true if this ArrayBuffer has been detached.
   */
  bool WasDetached() const;

  /**
   * Detaches this ArrayBuffer and all its views (typed arrays).
   * Detaching sets the byte length of the buffer and all typed arrays to zero,
   * preventing JavaScript from ever accessing underlying backing store.
   * ArrayBuffer should have been externalized and must be detachable.
   */
  V8_DEPRECATE_SOON(
      "Use the version which takes a key parameter (passing a null handle is "
      "ok).")
  void Detach();

  /**
   * Detaches this ArrayBuffer and all its views (typed arrays).
   * Detaching sets the byte length of the buffer and all typed arrays to zero,
   * preventing JavaScript from ever accessing underlying backing store.
   * ArrayBuffer should have been externalized and must be detachable. Returns
   * Nothing if the key didn't pass the [[ArrayBufferDetachKey]] check,
   * Just(true) otherwise.
   */
  V8_WARN_UNUSED_RESULT Maybe<bool> Detach(v8::Local<v8::Value> key);

  /**
   * Sets the ArrayBufferDetachKey.
   */
  void SetDetachKey(v8::Local<v8::Value> key);

  /**
   * Get a shared pointer to the backing store of this array buffer. This
   * pointer coordinates the lifetime management of the internal storage
   * with any live ArrayBuffers on the heap, even across isolates. The embedder
   * should not attempt to manage lifetime of the storage through other means.
   *
   * The returned shared pointer will not be empty, even if the ArrayBuffer has
   * been detached. Use |WasDetached| to tell if it has been detached instead.
   */
  std::shared_ptr<BackingStore> GetBackingStore();

  /**
   * More efficient shortcut for
   * GetBackingStore()->IsResizableByUserJavaScript().
   */
  bool IsResizableByUserJavaScript() const;

  /**
   * More efficient shortcut for GetBackingStore()->Data(). The returned pointer
   * is valid as long as the ArrayBuffer is alive.
   */
  void* Data() const;

  V8_INLINE static ArrayBuffer* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<ArrayBuffer*>(value);
  }

  static const int kInternalFieldCount = V8_ARRAY_BUFFER_INTERNAL_FIELD_COUNT;
  static const int kEmbedderFieldCount = V8_ARRAY_BUFFER_INTERNAL_FIELD_COUNT;

 private:
  ArrayBuffer();
  static void CheckCast(Value* obj);
};

#ifndef V8_ARRAY_BUFFER_VIEW_INTERNAL_FIELD_COUNT
// The number of required internal fields can be defined by embedder.
#define V8_ARRAY_BUFFER_VIEW_INTERNAL_FIELD_COUNT 2
#endif

/**
 * A base class for an instance of one of "views" over ArrayBuffer,
 * including TypedArrays and DataView (ES6 draft 15.13).
 */
class V8_EXPORT ArrayBufferView : public Object {
 public:
  /**
   * Returns underlying ArrayBuffer.
   */
  Local<ArrayBuffer> Buffer();
  /**
   * Byte offset in |Buffer|.
   */
  size_t ByteOffset();
  /**
   * Size of a view in bytes.
   */
  size_t ByteLength();

  /**
   * Copy the contents of the ArrayBufferView's buffer to an embedder defined
   * memory without additional overhead that calling ArrayBufferView::Buffer
   * might incur.
   *
   * Will write at most min(|byte_length|, ByteLength) bytes starting at
   * ByteOffset of the underlying buffer to the memory starting at |dest|.
   * Returns the number of bytes actually written.
   */
  size_t CopyContents(void* dest, size_t byte_length);

  /**
   * Returns true if ArrayBufferView's backing ArrayBuffer has already been
   * allocated.
   */
  bool HasBuffer() const;

  V8_INLINE static ArrayBufferView* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<ArrayBufferView*>(value);
  }

  static const int kInternalFieldCount =
      V8_ARRAY_BUFFER_VIEW_INTERNAL_FIELD_COUNT;
  static const int kEmbedderFieldCount =
      V8_ARRAY_BUFFER_VIEW_INTERNAL_FIELD_COUNT;

 private:
  ArrayBufferView();
  static void CheckCast(Value* obj);
};

/**
 * An instance of DataView constructor (ES6 draft 15.13.7).
 */
class V8_EXPORT DataView : public ArrayBufferView {
 public:
  static Local<DataView> New(Local<ArrayBuffer> array_buffer,
                             size_t byte_offset, size_t length);
  static Local<DataView> New(Local<SharedArrayBuffer> shared_array_buffer,
                             size_t byte_offset, size_t length);
  V8_INLINE static DataView* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<DataView*>(value);
  }

 private:
  DataView();
  static void CheckCast(Value* obj);
};

/**
 * An instance of the built-in SharedArrayBuffer constructor.
 */
class V8_EXPORT SharedArrayBuffer : public Object {
 public:
  /**
   * Data length in bytes.
   */
  size_t ByteLength() const;

  /**
   * Maximum length in bytes.
   */
  size_t MaxByteLength() const;

  /**
   * Create a new SharedArrayBuffer. Allocate |byte_length| bytes.
   * Allocated memory will be owned by a created SharedArrayBuffer and
   * will be deallocated when it is garbage-collected,
   * unless the object is externalized.
   */
  static Local<SharedArrayBuffer> New(Isolate* isolate, size_t byte_length);

  /**
   * Create a new SharedArrayBuffer with an existing backing store.
   * The created array keeps a reference to the backing store until the array
   * is garbage collected. Note that the IsExternal bit does not affect this
   * reference from the array to the backing store.
   *
   * In future IsExternal bit will be removed. Until then the bit is set as
   * follows. If the backing store does not own the underlying buffer, then
   * the array is created in externalized state. Otherwise, the array is created
   * in internalized state. In the latter case the array can be transitioned
   * to the externalized state using Externalize(backing_store).
   */
  static Local<SharedArrayBuffer> New(
      Isolate* isolate, std::shared_ptr<BackingStore> backing_store);

  /**
   * Returns a new standalone BackingStore that is allocated using the array
   * buffer allocator of the isolate. The result can be later passed to
   * SharedArrayBuffer::New.
   *
   * If the allocator returns nullptr, then the function may cause GCs in the
   * given isolate and re-try the allocation. If GCs do not help, then the
   * function will crash with an out-of-memory error.
   */
  static std::unique_ptr<BackingStore> NewBackingStore(Isolate* isolate,
                                                       size_t byte_length);
  /**
   * Returns a new standalone BackingStore that takes over the ownership of
   * the given buffer. The destructor of the BackingStore invokes the given
   * deleter callback.
   *
   * The result can be later passed to SharedArrayBuffer::New. The raw pointer
   * to the buffer must not be passed again to any V8 functions.
   */
  static std::unique_ptr<BackingStore> NewBackingStore(
      void* data, size_t byte_length, v8::BackingStore::DeleterCallback deleter,
      void* deleter_data);

  /**
   * Get a shared pointer to the backing store of this array buffer. This
   * pointer coordinates the lifetime management of the internal storage
   * with any live ArrayBuffers on the heap, even across isolates. The embedder
   * should not attempt to manage lifetime of the storage through other means.
   */
  std::shared_ptr<BackingStore> GetBackingStore();

  /**
   * More efficient shortcut for GetBackingStore()->Data(). The returned pointer
   * is valid as long as the ArrayBuffer is alive.
   */
  void* Data() const;

  V8_INLINE static SharedArrayBuffer* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<SharedArrayBuffer*>(value);
  }

  static const int kInternalFieldCount = V8_ARRAY_BUFFER_INTERNAL_FIELD_COUNT;

 private:
  SharedArrayBuffer();
  static void CheckCast(Value* obj);
};

}  // namespace v8

#endif  // INCLUDE_V8_ARRAY_BUFFER_H_
