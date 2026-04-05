// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_VALUE_SERIALIZER_H_
#define INCLUDE_V8_VALUE_SERIALIZER_H_

#include <stddef.h>
#include <stdint.h>

#include <memory>
#include <utility>

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-maybe.h"         // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class ArrayBuffer;
class Isolate;
class Object;
class SharedArrayBuffer;
class String;
class WasmModuleObject;
class Value;

namespace internal {
struct ScriptStreamingData;
class SharedObjectConveyorHandles;
class ValueDeserializer;
class ValueSerializer;
}  // namespace internal

/**
 * A move-only class for managing the lifetime of shared value conveyors used
 * by V8 to keep JS shared values alive in transit when serialized.
 *
 * This class is not directly constructible and is always passed to a
 * ValueSerializer::Delegate via ValueSerializer::SetSharedValueConveyor.
 *
 * The embedder must not destruct the SharedValueConveyor until the associated
 * serialized data will no longer be deserialized.
 */
class V8_EXPORT SharedValueConveyor final {
 public:
  SharedValueConveyor(SharedValueConveyor&&) noexcept;
  ~SharedValueConveyor();

  SharedValueConveyor& operator=(SharedValueConveyor&&) noexcept;

 private:
  friend class internal::ValueSerializer;
  friend class internal::ValueDeserializer;

  explicit SharedValueConveyor(Isolate* isolate);

  std::unique_ptr<internal::SharedObjectConveyorHandles> private_;
};

/**
 * Value serialization compatible with the HTML structured clone algorithm.
 * The format is backward-compatible (i.e. safe to store to disk).
 */
class V8_EXPORT ValueSerializer {
 public:
  class V8_EXPORT Delegate {
   public:
    virtual ~Delegate() = default;

    /**
     * Handles the case where a DataCloneError would be thrown in the structured
     * clone spec. Other V8 embedders may throw some other appropriate exception
     * type.
     */
    virtual void ThrowDataCloneError(Local<String> message) = 0;

    /**
     * The embedder overrides this method to enable custom host object filter
     * with Delegate::IsHostObject.
     *
     * This method is called at most once per serializer.
     */
    virtual bool HasCustomHostObject(Isolate* isolate);

    /**
     * The embedder overrides this method to determine if an JS object is a
     * host object and needs to be serialized by the host.
     */
    virtual Maybe<bool> IsHostObject(Isolate* isolate, Local<Object> object);

    /**
     * The embedder overrides this method to write some kind of host object, if
     * possible. If not, a suitable exception should be thrown and
     * Nothing<bool>() returned.
     */
    virtual Maybe<bool> WriteHostObject(Isolate* isolate, Local<Object> object);

    /**
     * Called when the ValueSerializer is going to serialize a
     * SharedArrayBuffer object. The embedder must return an ID for the
     * object, using the same ID if this SharedArrayBuffer has already been
     * serialized in this buffer. When deserializing, this ID will be passed to
     * ValueDeserializer::GetSharedArrayBufferFromId as |clone_id|.
     *
     * If the object cannot be serialized, an
     * exception should be thrown and Nothing<uint32_t>() returned.
     */
    virtual Maybe<uint32_t> GetSharedArrayBufferId(
        Isolate* isolate, Local<SharedArrayBuffer> shared_array_buffer);

    virtual Maybe<uint32_t> GetWasmModuleTransferId(
        Isolate* isolate, Local<WasmModuleObject> module);

    /**
     * Called when the first shared value is serialized. All subsequent shared
     * values will use the same conveyor.
     *
     * The embedder must ensure the lifetime of the conveyor matches the
     * lifetime of the serialized data.
     *
     * If the embedder supports serializing shared values, this method should
     * return true. Otherwise the embedder should throw an exception and return
     * false.
     *
     * This method is called at most once per serializer.
     */
    virtual bool AdoptSharedValueConveyor(Isolate* isolate,
                                          SharedValueConveyor&& conveyor);

    /**
     * Allocates memory for the buffer of at least the size provided. The actual
     * size (which may be greater or equal) is written to |actual_size|. If no
     * buffer has been allocated yet, nullptr will be provided.
     *
     * If the memory cannot be allocated, nullptr should be returned.
     * |actual_size| will be ignored. It is assumed that |old_buffer| is still
     * valid in this case and has not been modified.
     *
     * The default implementation uses the stdlib's `realloc()` function.
     */
    virtual void* ReallocateBufferMemory(void* old_buffer, size_t size,
                                         size_t* actual_size);

    /**
     * Frees a buffer allocated with |ReallocateBufferMemory|.
     *
     * The default implementation uses the stdlib's `free()` function.
     */
    virtual void FreeBufferMemory(void* buffer);
  };

  explicit ValueSerializer(Isolate* isolate);
  ValueSerializer(Isolate* isolate, Delegate* delegate);
  ~ValueSerializer();

  /**
   * Writes out a header, which includes the format version.
   */
  void WriteHeader();

  /**
   * Serializes a JavaScript value into the buffer.
   */
  V8_WARN_UNUSED_RESULT Maybe<bool> WriteValue(Local<Context> context,
                                               Local<Value> value);

  /**
   * Returns the stored data (allocated using the delegate's
   * ReallocateBufferMemory) and its size. This serializer should not be used
   * once the buffer is released. The contents are undefined if a previous write
   * has failed. Ownership of the buffer is transferred to the caller.
   */
  V8_WARN_UNUSED_RESULT std::pair<uint8_t*, size_t> Release();

  /**
   * Marks an ArrayBuffer as havings its contents transferred out of band.
   * Pass the corresponding ArrayBuffer in the deserializing context to
   * ValueDeserializer::TransferArrayBuffer.
   */
  void TransferArrayBuffer(uint32_t transfer_id,
                           Local<ArrayBuffer> array_buffer);

  /**
   * Indicate whether to treat ArrayBufferView objects as host objects,
   * i.e. pass them to Delegate::WriteHostObject. This should not be
   * called when no Delegate was passed.
   *
   * The default is not to treat ArrayBufferViews as host objects.
   */
  void SetTreatArrayBufferViewsAsHostObjects(bool mode);

  /**
   * Write raw data in various common formats to the buffer.
   * Note that integer types are written in base-128 varint format, not with a
   * binary copy. For use during an override of Delegate::WriteHostObject.
   */
  void WriteUint32(uint32_t value);
  void WriteUint64(uint64_t value);
  void WriteDouble(double value);
  void WriteRawBytes(const void* source, size_t length);

  ValueSerializer(const ValueSerializer&) = delete;
  void operator=(const ValueSerializer&) = delete;

 private:
  struct PrivateData;
  PrivateData* private_;
};

/**
 * Deserializes values from data written with ValueSerializer, or a compatible
 * implementation.
 */
class V8_EXPORT ValueDeserializer {
 public:
  class V8_EXPORT Delegate {
   public:
    virtual ~Delegate() = default;

    /**
     * The embedder overrides this method to read some kind of host object, if
     * possible. If not, a suitable exception should be thrown and
     * MaybeLocal<Object>() returned.
     */
    virtual MaybeLocal<Object> ReadHostObject(Isolate* isolate);

    /**
     * Get a WasmModuleObject given a transfer_id previously provided
     * by ValueSerializer::Delegate::GetWasmModuleTransferId
     */
    virtual MaybeLocal<WasmModuleObject> GetWasmModuleFromId(
        Isolate* isolate, uint32_t transfer_id);

    /**
     * Get a SharedArrayBuffer given a clone_id previously provided
     * by ValueSerializer::Delegate::GetSharedArrayBufferId
     */
    virtual MaybeLocal<SharedArrayBuffer> GetSharedArrayBufferFromId(
        Isolate* isolate, uint32_t clone_id);

    /**
     * Get the SharedValueConveyor previously provided by
     * ValueSerializer::Delegate::AdoptSharedValueConveyor.
     */
    virtual const SharedValueConveyor* GetSharedValueConveyor(Isolate* isolate);
  };

  ValueDeserializer(Isolate* isolate, const uint8_t* data, size_t size);
  ValueDeserializer(Isolate* isolate, const uint8_t* data, size_t size,
                    Delegate* delegate);
  ~ValueDeserializer();

  /**
   * Reads and validates a header (including the format version).
   * May, for example, reject an invalid or unsupported wire format.
   */
  V8_WARN_UNUSED_RESULT Maybe<bool> ReadHeader(Local<Context> context);

  /**
   * Deserializes a JavaScript value from the buffer.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Value> ReadValue(Local<Context> context);

  /**
   * Accepts the array buffer corresponding to the one passed previously to
   * ValueSerializer::TransferArrayBuffer.
   */
  void TransferArrayBuffer(uint32_t transfer_id,
                           Local<ArrayBuffer> array_buffer);

  /**
   * Similar to TransferArrayBuffer, but for SharedArrayBuffer.
   * The id is not necessarily in the same namespace as unshared ArrayBuffer
   * objects.
   */
  void TransferSharedArrayBuffer(uint32_t id,
                                 Local<SharedArrayBuffer> shared_array_buffer);

  /**
   * Must be called before ReadHeader to enable support for reading the legacy
   * wire format (i.e., which predates this being shipped).
   *
   * Don't use this unless you need to read data written by previous versions of
   * blink::ScriptValueSerializer.
   */
  void SetSupportsLegacyWireFormat(bool supports_legacy_wire_format);

  /**
   * Reads the underlying wire format version. Likely mostly to be useful to
   * legacy code reading old wire format versions. Must be called after
   * ReadHeader.
   */
  uint32_t GetWireFormatVersion() const;

  /**
   * Reads raw data in various common formats to the buffer.
   * Note that integer types are read in base-128 varint format, not with a
   * binary copy. For use during an override of Delegate::ReadHostObject.
   */
  V8_WARN_UNUSED_RESULT bool ReadUint32(uint32_t* value);
  V8_WARN_UNUSED_RESULT bool ReadUint64(uint64_t* value);
  V8_WARN_UNUSED_RESULT bool ReadDouble(double* value);
  V8_WARN_UNUSED_RESULT bool ReadRawBytes(size_t length, const void** data);

  ValueDeserializer(const ValueDeserializer&) = delete;
  void operator=(const ValueDeserializer&) = delete;

 private:
  struct PrivateData;
  PrivateData* private_;
};

}  // namespace v8

#endif  // INCLUDE_V8_VALUE_SERIALIZER_H_
