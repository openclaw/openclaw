// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_TYPED_ARRAY_H_
#define INCLUDE_V8_TYPED_ARRAY_H_

#include <limits>

#include "v8-array-buffer.h"  // NOLINT(build/include_directory)
#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

/**
 * A base class for an instance of TypedArray series of constructors
 * (ES6 draft 15.13.6).
 */
class V8_EXPORT TypedArray : public ArrayBufferView {
 public:
  /*
   * The largest supported typed array byte size. Each subclass defines a
   * type-specific kMaxLength for the maximum length that can be passed to New.
   */
#if V8_ENABLE_SANDBOX
  static constexpr size_t kMaxByteLength =
      internal::kMaxSafeBufferSizeForSandbox;
#elif V8_HOST_ARCH_32_BIT
  static constexpr size_t kMaxByteLength = std::numeric_limits<int>::max();
#else
  // The maximum safe integer (2^53 - 1).
  static constexpr size_t kMaxByteLength =
      static_cast<size_t>((uint64_t{1} << 53) - 1);
#endif

  /**
   * Number of elements in this typed array
   * (e.g. for Int16Array, |ByteLength|/2).
   */
  size_t Length();

  V8_INLINE static TypedArray* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<TypedArray*>(value);
  }

 private:
  TypedArray();
  static void CheckCast(Value* obj);
};

/**
 * An instance of Uint8Array constructor (ES6 draft 15.13.6).
 */
class V8_EXPORT Uint8Array : public TypedArray {
 public:
  /*
   * The largest Uint8Array size that can be constructed using New.
   */
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(uint8_t);
  static_assert(sizeof(uint8_t) == 1);

  static Local<Uint8Array> New(Local<ArrayBuffer> array_buffer,
                               size_t byte_offset, size_t length);
  static Local<Uint8Array> New(Local<SharedArrayBuffer> shared_array_buffer,
                               size_t byte_offset, size_t length);
  V8_INLINE static Uint8Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Uint8Array*>(value);
  }

 private:
  Uint8Array();
  static void CheckCast(Value* obj);
};

/**
 * An instance of Uint8ClampedArray constructor (ES6 draft 15.13.6).
 */
class V8_EXPORT Uint8ClampedArray : public TypedArray {
 public:
  /*
   * The largest Uint8ClampedArray size that can be constructed using New.
   */
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(uint8_t);
  static_assert(sizeof(uint8_t) == 1);

  static Local<Uint8ClampedArray> New(Local<ArrayBuffer> array_buffer,
                                      size_t byte_offset, size_t length);
  static Local<Uint8ClampedArray> New(
      Local<SharedArrayBuffer> shared_array_buffer, size_t byte_offset,
      size_t length);
  V8_INLINE static Uint8ClampedArray* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Uint8ClampedArray*>(value);
  }

 private:
  Uint8ClampedArray();
  static void CheckCast(Value* obj);
};

/**
 * An instance of Int8Array constructor (ES6 draft 15.13.6).
 */
class V8_EXPORT Int8Array : public TypedArray {
 public:
  /*
   * The largest Int8Array size that can be constructed using New.
   */
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(int8_t);
  static_assert(sizeof(int8_t) == 1);

  static Local<Int8Array> New(Local<ArrayBuffer> array_buffer,
                              size_t byte_offset, size_t length);
  static Local<Int8Array> New(Local<SharedArrayBuffer> shared_array_buffer,
                              size_t byte_offset, size_t length);
  V8_INLINE static Int8Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Int8Array*>(value);
  }

 private:
  Int8Array();
  static void CheckCast(Value* obj);
};

/**
 * An instance of Uint16Array constructor (ES6 draft 15.13.6).
 */
class V8_EXPORT Uint16Array : public TypedArray {
 public:
  /*
   * The largest Uint16Array size that can be constructed using New.
   */
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(uint16_t);
  static_assert(sizeof(uint16_t) == 2);

  static Local<Uint16Array> New(Local<ArrayBuffer> array_buffer,
                                size_t byte_offset, size_t length);
  static Local<Uint16Array> New(Local<SharedArrayBuffer> shared_array_buffer,
                                size_t byte_offset, size_t length);
  V8_INLINE static Uint16Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Uint16Array*>(value);
  }

 private:
  Uint16Array();
  static void CheckCast(Value* obj);
};

/**
 * An instance of Int16Array constructor (ES6 draft 15.13.6).
 */
class V8_EXPORT Int16Array : public TypedArray {
 public:
  /*
   * The largest Int16Array size that can be constructed using New.
   */
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(int16_t);
  static_assert(sizeof(int16_t) == 2);

  static Local<Int16Array> New(Local<ArrayBuffer> array_buffer,
                               size_t byte_offset, size_t length);
  static Local<Int16Array> New(Local<SharedArrayBuffer> shared_array_buffer,
                               size_t byte_offset, size_t length);
  V8_INLINE static Int16Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Int16Array*>(value);
  }

 private:
  Int16Array();
  static void CheckCast(Value* obj);
};

/**
 * An instance of Uint32Array constructor (ES6 draft 15.13.6).
 */
class V8_EXPORT Uint32Array : public TypedArray {
 public:
  /*
   * The largest Uint32Array size that can be constructed using New.
   */
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(uint32_t);
  static_assert(sizeof(uint32_t) == 4);

  static Local<Uint32Array> New(Local<ArrayBuffer> array_buffer,
                                size_t byte_offset, size_t length);
  static Local<Uint32Array> New(Local<SharedArrayBuffer> shared_array_buffer,
                                size_t byte_offset, size_t length);
  V8_INLINE static Uint32Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Uint32Array*>(value);
  }

 private:
  Uint32Array();
  static void CheckCast(Value* obj);
};

/**
 * An instance of Int32Array constructor (ES6 draft 15.13.6).
 */
class V8_EXPORT Int32Array : public TypedArray {
 public:
  /*
   * The largest Int32Array size that can be constructed using New.
   */
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(int32_t);
  static_assert(sizeof(int32_t) == 4);

  static Local<Int32Array> New(Local<ArrayBuffer> array_buffer,
                               size_t byte_offset, size_t length);
  static Local<Int32Array> New(Local<SharedArrayBuffer> shared_array_buffer,
                               size_t byte_offset, size_t length);
  V8_INLINE static Int32Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Int32Array*>(value);
  }

 private:
  Int32Array();
  static void CheckCast(Value* obj);
};

/**
 * An instance of Float16Array constructor.
 */
class V8_EXPORT Float16Array : public TypedArray {
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(uint16_t);

 public:
  static Local<Float16Array> New(Local<ArrayBuffer> array_buffer,
                                 size_t byte_offset, size_t length);
  static Local<Float16Array> New(Local<SharedArrayBuffer> shared_array_buffer,
                                 size_t byte_offset, size_t length);
  V8_INLINE static Float16Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Float16Array*>(value);
  }

 private:
  Float16Array();
  static void CheckCast(Value* obj);
};

/**
 * An instance of Float32Array constructor (ES6 draft 15.13.6).
 */
class V8_EXPORT Float32Array : public TypedArray {
 public:
  /*
   * The largest Float32Array size that can be constructed using New.
   */
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(float);
  static_assert(sizeof(float) == 4);

  static Local<Float32Array> New(Local<ArrayBuffer> array_buffer,
                                 size_t byte_offset, size_t length);
  static Local<Float32Array> New(Local<SharedArrayBuffer> shared_array_buffer,
                                 size_t byte_offset, size_t length);
  V8_INLINE static Float32Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Float32Array*>(value);
  }

 private:
  Float32Array();
  static void CheckCast(Value* obj);
};

/**
 * An instance of Float64Array constructor (ES6 draft 15.13.6).
 */
class V8_EXPORT Float64Array : public TypedArray {
 public:
  /*
   * The largest Float64Array size that can be constructed using New.
   */
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(double);
  static_assert(sizeof(double) == 8);

  static Local<Float64Array> New(Local<ArrayBuffer> array_buffer,
                                 size_t byte_offset, size_t length);
  static Local<Float64Array> New(Local<SharedArrayBuffer> shared_array_buffer,
                                 size_t byte_offset, size_t length);
  V8_INLINE static Float64Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Float64Array*>(value);
  }

 private:
  Float64Array();
  static void CheckCast(Value* obj);
};

/**
 * An instance of BigInt64Array constructor.
 */
class V8_EXPORT BigInt64Array : public TypedArray {
 public:
  /*
   * The largest BigInt64Array size that can be constructed using New.
   */
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(int64_t);
  static_assert(sizeof(int64_t) == 8);

  static Local<BigInt64Array> New(Local<ArrayBuffer> array_buffer,
                                  size_t byte_offset, size_t length);
  static Local<BigInt64Array> New(Local<SharedArrayBuffer> shared_array_buffer,
                                  size_t byte_offset, size_t length);
  V8_INLINE static BigInt64Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<BigInt64Array*>(value);
  }

 private:
  BigInt64Array();
  static void CheckCast(Value* obj);
};

/**
 * An instance of BigUint64Array constructor.
 */
class V8_EXPORT BigUint64Array : public TypedArray {
 public:
  /*
   * The largest BigUint64Array size that can be constructed using New.
   */
  static constexpr size_t kMaxLength =
      TypedArray::kMaxByteLength / sizeof(uint64_t);
  static_assert(sizeof(uint64_t) == 8);

  static Local<BigUint64Array> New(Local<ArrayBuffer> array_buffer,
                                   size_t byte_offset, size_t length);
  static Local<BigUint64Array> New(Local<SharedArrayBuffer> shared_array_buffer,
                                   size_t byte_offset, size_t length);
  V8_INLINE static BigUint64Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<BigUint64Array*>(value);
  }

 private:
  BigUint64Array();
  static void CheckCast(Value* obj);
};

}  // namespace v8

#endif  // INCLUDE_V8_TYPED_ARRAY_H_
