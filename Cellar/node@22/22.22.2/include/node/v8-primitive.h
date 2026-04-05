// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_PRIMITIVE_H_
#define INCLUDE_V8_PRIMITIVE_H_

#include "v8-data.h"          // NOLINT(build/include_directory)
#include "v8-internal.h"      // NOLINT(build/include_directory)
#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-value.h"         // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Context;
class Isolate;
class String;

namespace internal {
class ExternalString;
class ScopedExternalStringLock;
class StringForwardingTable;
}  // namespace internal

/**
 * The superclass of primitive values.  See ECMA-262 4.3.2.
 */
class V8_EXPORT Primitive : public Value {};

/**
 * A primitive boolean value (ECMA-262, 4.3.14).  Either the true
 * or false value.
 */
class V8_EXPORT Boolean : public Primitive {
 public:
  bool Value() const;
  V8_INLINE static Boolean* Cast(v8::Data* data) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(data);
#endif
    return static_cast<Boolean*>(data);
  }

  V8_INLINE static Local<Boolean> New(Isolate* isolate, bool value);

 private:
  static void CheckCast(v8::Data* that);
};

/**
 * An array to hold Primitive values. This is used by the embedder to
 * pass host defined options to the ScriptOptions during compilation.
 *
 * This is passed back to the embedder as part of
 * HostImportModuleDynamicallyCallback for module loading.
 */
class V8_EXPORT PrimitiveArray : public Data {
 public:
  static Local<PrimitiveArray> New(Isolate* isolate, int length);
  int Length() const;
  void Set(Isolate* isolate, int index, Local<Primitive> item);
  Local<Primitive> Get(Isolate* isolate, int index);

  V8_INLINE static PrimitiveArray* Cast(Data* data) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(data);
#endif
    return reinterpret_cast<PrimitiveArray*>(data);
  }

 private:
  static void CheckCast(Data* obj);
};

/**
 * A superclass for symbols and strings.
 */
class V8_EXPORT Name : public Primitive {
 public:
  /**
   * Returns the identity hash for this object. The current implementation
   * uses an inline property on the object to store the identity hash.
   *
   * The return value will never be 0. Also, it is not guaranteed to be
   * unique.
   */
  int GetIdentityHash();

  V8_INLINE static Name* Cast(Data* data) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(data);
#endif
    return static_cast<Name*>(data);
  }

 private:
  static void CheckCast(Data* that);
};

/**
 * A flag describing different modes of string creation.
 *
 * Aside from performance implications there are no differences between the two
 * creation modes.
 */
enum class NewStringType {
  /**
   * Create a new string, always allocating new storage memory.
   */
  kNormal,

  /**
   * Acts as a hint that the string should be created in the
   * old generation heap space and be deduplicated if an identical string
   * already exists.
   */
  kInternalized
};

/**
 * A JavaScript string value (ECMA-262, 4.3.17).
 */
class V8_EXPORT String : public Name {
 public:
  static constexpr int kMaxLength =
      internal::kApiSystemPointerSize == 4 ? (1 << 28) - 16 : (1 << 29) - 24;

  enum Encoding {
    UNKNOWN_ENCODING = 0x1,
    TWO_BYTE_ENCODING = 0x0,
    ONE_BYTE_ENCODING = 0x8
  };
  /**
   * Returns the number of characters (UTF-16 code units) in this string.
   */
  int Length() const;

  /**
   * Returns the number of bytes in the UTF-8 encoded
   * representation of this string.
   */
  int Utf8Length(Isolate* isolate) const;

  /**
   * Returns whether this string is known to contain only one byte data,
   * i.e. ISO-8859-1 code points.
   * Does not read the string.
   * False negatives are possible.
   */
  bool IsOneByte() const;

  /**
   * Returns whether this string contain only one byte data,
   * i.e. ISO-8859-1 code points.
   * Will read the entire string in some cases.
   */
  bool ContainsOnlyOneByte() const;

  /**
   * Write the contents of the string to an external buffer.
   * If no arguments are given, expects the buffer to be large
   * enough to hold the entire string and NULL terminator. Copies
   * the contents of the string and the NULL terminator into the
   * buffer.
   *
   * WriteUtf8 will not write partial UTF-8 sequences, preferring to stop
   * before the end of the buffer.
   *
   * Copies up to length characters into the output buffer.
   * Only null-terminates if there is enough space in the buffer.
   *
   * \param buffer The buffer into which the string will be copied.
   * \param start The starting position within the string at which
   * copying begins.
   * \param length The number of characters to copy from the string.  For
   *    WriteUtf8 the number of bytes in the buffer.
   * \param nchars_ref The number of characters written, can be NULL.
   * \param options Various options that might affect performance of this or
   *    subsequent operations.
   * \return The number of characters copied to the buffer excluding the null
   *    terminator.  For WriteUtf8: The number of bytes copied to the buffer
   *    including the null terminator (if written).
   */
  enum WriteOptions {
    NO_OPTIONS = 0,
    HINT_MANY_WRITES_EXPECTED = 1,
    NO_NULL_TERMINATION = 2,
    PRESERVE_ONE_BYTE_NULL = 4,
    // Used by WriteUtf8 to replace orphan surrogate code units with the
    // unicode replacement character. Needs to be set to guarantee valid UTF-8
    // output.
    REPLACE_INVALID_UTF8 = 8
  };

  // 16-bit character codes.
  int Write(Isolate* isolate, uint16_t* buffer, int start = 0, int length = -1,
            int options = NO_OPTIONS) const;
  // One byte characters.
  int WriteOneByte(Isolate* isolate, uint8_t* buffer, int start = 0,
                   int length = -1, int options = NO_OPTIONS) const;
  // UTF-8 encoded characters.
  int WriteUtf8(Isolate* isolate, char* buffer, int length = -1,
                int* nchars_ref = nullptr, int options = NO_OPTIONS) const;

  /**
   * A zero length string.
   */
  V8_INLINE static Local<String> Empty(Isolate* isolate);

  /**
   * Returns true if the string is external.
   */
  bool IsExternal() const;

  /**
   * Returns true if the string is both external and two-byte.
   */
  bool IsExternalTwoByte() const;

  /**
   * Returns true if the string is both external and one-byte.
   */
  bool IsExternalOneByte() const;

  class V8_EXPORT ExternalStringResourceBase {
   public:
    virtual ~ExternalStringResourceBase() = default;

    /**
     * If a string is cacheable, the value returned by
     * ExternalStringResource::data() may be cached, otherwise it is not
     * expected to be stable beyond the current top-level task.
     */
    virtual bool IsCacheable() const { return true; }

    // Disallow copying and assigning.
    ExternalStringResourceBase(const ExternalStringResourceBase&) = delete;
    void operator=(const ExternalStringResourceBase&) = delete;

   protected:
    ExternalStringResourceBase() = default;

    /**
     * Internally V8 will call this Dispose method when the external string
     * resource is no longer needed. The default implementation will use the
     * delete operator. This method can be overridden in subclasses to
     * control how allocated external string resources are disposed.
     */
    virtual void Dispose() { delete this; }

    /**
     * For a non-cacheable string, the value returned by
     * |ExternalStringResource::data()| has to be stable between |Lock()| and
     * |Unlock()|, that is the string must behave as is |IsCacheable()| returned
     * true.
     *
     * These two functions must be thread-safe, and can be called from anywhere.
     * They also must handle lock depth, in the sense that each can be called
     * several times, from different threads, and unlocking should only happen
     * when the balance of Lock() and Unlock() calls is 0.
     */
    virtual void Lock() const {}

    /**
     * Unlocks the string.
     */
    virtual void Unlock() const {}

   private:
    friend class internal::ExternalString;
    friend class v8::String;
    friend class internal::StringForwardingTable;
    friend class internal::ScopedExternalStringLock;
  };

  /**
   * An ExternalStringResource is a wrapper around a two-byte string
   * buffer that resides outside V8's heap. Implement an
   * ExternalStringResource to manage the life cycle of the underlying
   * buffer.  Note that the string data must be immutable.
   */
  class V8_EXPORT ExternalStringResource : public ExternalStringResourceBase {
   public:
    /**
     * Override the destructor to manage the life cycle of the underlying
     * buffer.
     */
    ~ExternalStringResource() override = default;

    /**
     * The string data from the underlying buffer. If the resource is cacheable
     * then data() must return the same value for all invocations.
     */
    virtual const uint16_t* data() const = 0;

    /**
     * The length of the string. That is, the number of two-byte characters.
     */
    virtual size_t length() const = 0;

    /**
     * Returns the cached data from the underlying buffer. This method can be
     * called only for cacheable resources (i.e. IsCacheable() == true) and only
     * after UpdateDataCache() was called.
     */
    const uint16_t* cached_data() const {
      CheckCachedDataInvariants();
      return cached_data_;
    }

    /**
     * Update {cached_data_} with the data from the underlying buffer. This can
     * be called only for cacheable resources.
     */
    void UpdateDataCache();

   protected:
    ExternalStringResource() = default;

   private:
    void CheckCachedDataInvariants() const;

    const uint16_t* cached_data_ = nullptr;
  };

  /**
   * An ExternalOneByteStringResource is a wrapper around an one-byte
   * string buffer that resides outside V8's heap. Implement an
   * ExternalOneByteStringResource to manage the life cycle of the
   * underlying buffer.  Note that the string data must be immutable
   * and that the data must be Latin-1 and not UTF-8, which would require
   * special treatment internally in the engine and do not allow efficient
   * indexing.  Use String::New or convert to 16 bit data for non-Latin1.
   */

  class V8_EXPORT ExternalOneByteStringResource
      : public ExternalStringResourceBase {
   public:
    /**
     * Override the destructor to manage the life cycle of the underlying
     * buffer.
     */
    ~ExternalOneByteStringResource() override = default;

    /**
     * The string data from the underlying buffer. If the resource is cacheable
     * then data() must return the same value for all invocations.
     */
    virtual const char* data() const = 0;

    /** The number of Latin-1 characters in the string.*/
    virtual size_t length() const = 0;

    /**
     * Returns the cached data from the underlying buffer. If the resource is
     * uncacheable or if UpdateDataCache() was not called before, it has
     * undefined behaviour.
     */
    const char* cached_data() const {
      CheckCachedDataInvariants();
      return cached_data_;
    }

    /**
     * Update {cached_data_} with the data from the underlying buffer. This can
     * be called only for cacheable resources.
     */
    void UpdateDataCache();

   protected:
    ExternalOneByteStringResource() = default;

   private:
    void CheckCachedDataInvariants() const;

    const char* cached_data_ = nullptr;
  };

  /**
   * If the string is an external string, return the ExternalStringResourceBase
   * regardless of the encoding, otherwise return NULL.  The encoding of the
   * string is returned in encoding_out.
   */
  V8_INLINE ExternalStringResourceBase* GetExternalStringResourceBase(
      Encoding* encoding_out) const;

  /**
   * Get the ExternalStringResource for an external string.  Returns
   * NULL if IsExternal() doesn't return true.
   */
  V8_INLINE ExternalStringResource* GetExternalStringResource() const;

  /**
   * Get the ExternalOneByteStringResource for an external one-byte string.
   * Returns NULL if IsExternalOneByte() doesn't return true.
   */
  const ExternalOneByteStringResource* GetExternalOneByteStringResource() const;

  V8_INLINE static String* Cast(v8::Data* data) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(data);
#endif
    return static_cast<String*>(data);
  }

  /**
   * Allocates a new string from a UTF-8 literal. This is equivalent to calling
   * String::NewFromUtf(isolate, "...").ToLocalChecked(), but without the check
   * overhead.
   *
   * When called on a string literal containing '\0', the inferred length is the
   * length of the input array minus 1 (for the final '\0') and not the value
   * returned by strlen.
   **/
  template <int N>
  static V8_WARN_UNUSED_RESULT Local<String> NewFromUtf8Literal(
      Isolate* isolate, const char (&literal)[N],
      NewStringType type = NewStringType::kNormal) {
    static_assert(N <= kMaxLength, "String is too long");
    return NewFromUtf8Literal(isolate, literal, type, N - 1);
  }

  /** Allocates a new string from UTF-8 data. Only returns an empty value when
   * length > kMaxLength. **/
  static V8_WARN_UNUSED_RESULT MaybeLocal<String> NewFromUtf8(
      Isolate* isolate, const char* data,
      NewStringType type = NewStringType::kNormal, int length = -1);

  /** Allocates a new string from Latin-1 data.  Only returns an empty value
   * when length > kMaxLength. **/
  static V8_WARN_UNUSED_RESULT MaybeLocal<String> NewFromOneByte(
      Isolate* isolate, const uint8_t* data,
      NewStringType type = NewStringType::kNormal, int length = -1);

  /** Allocates a new string from UTF-16 data. Only returns an empty value when
   * length > kMaxLength. **/
  static V8_WARN_UNUSED_RESULT MaybeLocal<String> NewFromTwoByte(
      Isolate* isolate, const uint16_t* data,
      NewStringType type = NewStringType::kNormal, int length = -1);

  /**
   * Creates a new string by concatenating the left and the right strings
   * passed in as parameters.
   */
  static Local<String> Concat(Isolate* isolate, Local<String> left,
                              Local<String> right);

  /**
   * Creates a new external string using the data defined in the given
   * resource. When the external string is no longer live on V8's heap the
   * resource will be disposed by calling its Dispose method. The caller of
   * this function should not otherwise delete or modify the resource. Neither
   * should the underlying buffer be deallocated or modified except through the
   * destructor of the external string resource.
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<String> NewExternalTwoByte(
      Isolate* isolate, ExternalStringResource* resource);

  /**
   * Associate an external string resource with this string by transforming it
   * in place so that existing references to this string in the JavaScript heap
   * will use the external string resource. The external string resource's
   * character contents need to be equivalent to this string.
   * Returns true if the string has been changed to be an external string.
   * The string is not modified if the operation fails. See NewExternal for
   * information on the lifetime of the resource.
   */
  bool MakeExternal(ExternalStringResource* resource);

  /**
   * Creates a new external string using the one-byte data defined in the given
   * resource. When the external string is no longer live on V8's heap the
   * resource will be disposed by calling its Dispose method. The caller of
   * this function should not otherwise delete or modify the resource. Neither
   * should the underlying buffer be deallocated or modified except through the
   * destructor of the external string resource.
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<String> NewExternalOneByte(
      Isolate* isolate, ExternalOneByteStringResource* resource);

  /**
   * Associate an external string resource with this string by transforming it
   * in place so that existing references to this string in the JavaScript heap
   * will use the external string resource. The external string resource's
   * character contents need to be equivalent to this string.
   * Returns true if the string has been changed to be an external string.
   * The string is not modified if the operation fails. See NewExternal for
   * information on the lifetime of the resource.
   */
  bool MakeExternal(ExternalOneByteStringResource* resource);

  /**
   * Returns true if this string can be made external, given the encoding for
   * the external string resource.
   */
  bool CanMakeExternal(Encoding encoding) const;

  /**
   * Returns true if the strings values are equal. Same as JS ==/===.
   */
  bool StringEquals(Local<String> str) const;

  /**
   * Converts an object to a UTF-8-encoded character array.  Useful if
   * you want to print the object.  If conversion to a string fails
   * (e.g. due to an exception in the toString() method of the object)
   * then the length() method returns 0 and the * operator returns
   * NULL.
   */
  class V8_EXPORT Utf8Value {
   public:
    Utf8Value(Isolate* isolate, Local<v8::Value> obj);
    ~Utf8Value();
    char* operator*() { return str_; }
    const char* operator*() const { return str_; }
    int length() const { return length_; }

    // Disallow copying and assigning.
    Utf8Value(const Utf8Value&) = delete;
    void operator=(const Utf8Value&) = delete;

   private:
    char* str_;
    int length_;
  };

  /**
   * Converts an object to a two-byte (UTF-16-encoded) string.
   * If conversion to a string fails (eg. due to an exception in the toString()
   * method of the object) then the length() method returns 0 and the * operator
   * returns NULL.
   */
  class V8_EXPORT Value {
   public:
    Value(Isolate* isolate, Local<v8::Value> obj);
    ~Value();
    uint16_t* operator*() { return str_; }
    const uint16_t* operator*() const { return str_; }
    int length() const { return length_; }

    // Disallow copying and assigning.
    Value(const Value&) = delete;
    void operator=(const Value&) = delete;

   private:
    uint16_t* str_;
    int length_;
  };

 private:
  void VerifyExternalStringResourceBase(ExternalStringResourceBase* v,
                                        Encoding encoding) const;
  void VerifyExternalStringResource(ExternalStringResource* val) const;
  ExternalStringResource* GetExternalStringResourceSlow() const;
  ExternalStringResourceBase* GetExternalStringResourceBaseSlow(
      String::Encoding* encoding_out) const;

  static Local<v8::String> NewFromUtf8Literal(Isolate* isolate,
                                              const char* literal,
                                              NewStringType type, int length);

  static void CheckCast(v8::Data* that);
};

// Zero-length string specialization (templated string size includes
// terminator).
template <>
inline V8_WARN_UNUSED_RESULT Local<String> String::NewFromUtf8Literal(
    Isolate* isolate, const char (&literal)[1], NewStringType type) {
  return String::Empty(isolate);
}

/**
 * Interface for iterating through all external resources in the heap.
 */
class V8_EXPORT ExternalResourceVisitor {
 public:
  virtual ~ExternalResourceVisitor() = default;
  virtual void VisitExternalString(Local<String> string) {}
};

/**
 * A JavaScript symbol (ECMA-262 edition 6)
 */
class V8_EXPORT Symbol : public Name {
 public:
  /**
   * Returns the description string of the symbol, or undefined if none.
   */
  Local<Value> Description(Isolate* isolate) const;

  /**
   * Create a symbol. If description is not empty, it will be used as the
   * description.
   */
  static Local<Symbol> New(Isolate* isolate,
                           Local<String> description = Local<String>());

  /**
   * Access global symbol registry.
   * Note that symbols created this way are never collected, so
   * they should only be used for statically fixed properties.
   * Also, there is only one global name space for the descriptions used as
   * keys.
   * To minimize the potential for clashes, use qualified names as keys.
   */
  static Local<Symbol> For(Isolate* isolate, Local<String> description);

  /**
   * Retrieve a global symbol. Similar to |For|, but using a separate
   * registry that is not accessible by (and cannot clash with) JavaScript code.
   */
  static Local<Symbol> ForApi(Isolate* isolate, Local<String> description);

  // Well-known symbols
  static Local<Symbol> GetAsyncIterator(Isolate* isolate);
  static Local<Symbol> GetHasInstance(Isolate* isolate);
  static Local<Symbol> GetIsConcatSpreadable(Isolate* isolate);
  static Local<Symbol> GetIterator(Isolate* isolate);
  static Local<Symbol> GetMatch(Isolate* isolate);
  static Local<Symbol> GetReplace(Isolate* isolate);
  static Local<Symbol> GetSearch(Isolate* isolate);
  static Local<Symbol> GetSplit(Isolate* isolate);
  static Local<Symbol> GetToPrimitive(Isolate* isolate);
  static Local<Symbol> GetToStringTag(Isolate* isolate);
  static Local<Symbol> GetUnscopables(Isolate* isolate);

  V8_INLINE static Symbol* Cast(Data* data) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(data);
#endif
    return static_cast<Symbol*>(data);
  }

 private:
  Symbol();
  static void CheckCast(Data* that);
};

/**
 * A JavaScript numeric value (either Number or BigInt).
 * https://tc39.es/ecma262/#sec-numeric-types
 */
class V8_EXPORT Numeric : public Primitive {
 private:
  Numeric();
  static void CheckCast(v8::Data* that);
};

/**
 * A JavaScript number value (ECMA-262, 4.3.20)
 */
class V8_EXPORT Number : public Numeric {
 public:
  double Value() const;
  static Local<Number> New(Isolate* isolate, double value);
  V8_INLINE static Number* Cast(v8::Data* data) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(data);
#endif
    return static_cast<Number*>(data);
  }

 private:
  Number();
  static void CheckCast(v8::Data* that);
};

/**
 * A JavaScript value representing a signed integer.
 */
class V8_EXPORT Integer : public Number {
 public:
  static Local<Integer> New(Isolate* isolate, int32_t value);
  static Local<Integer> NewFromUnsigned(Isolate* isolate, uint32_t value);
  int64_t Value() const;
  V8_INLINE static Integer* Cast(v8::Data* data) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(data);
#endif
    return static_cast<Integer*>(data);
  }

 private:
  Integer();
  static void CheckCast(v8::Data* that);
};

/**
 * A JavaScript value representing a 32-bit signed integer.
 */
class V8_EXPORT Int32 : public Integer {
 public:
  int32_t Value() const;
  V8_INLINE static Int32* Cast(v8::Data* data) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(data);
#endif
    return static_cast<Int32*>(data);
  }

 private:
  Int32();
  static void CheckCast(v8::Data* that);
};

/**
 * A JavaScript value representing a 32-bit unsigned integer.
 */
class V8_EXPORT Uint32 : public Integer {
 public:
  uint32_t Value() const;
  V8_INLINE static Uint32* Cast(v8::Data* data) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(data);
#endif
    return static_cast<Uint32*>(data);
  }

 private:
  Uint32();
  static void CheckCast(v8::Data* that);
};

/**
 * A JavaScript BigInt value (https://tc39.github.io/proposal-bigint)
 */
class V8_EXPORT BigInt : public Numeric {
 public:
  static Local<BigInt> New(Isolate* isolate, int64_t value);
  static Local<BigInt> NewFromUnsigned(Isolate* isolate, uint64_t value);
  /**
   * Creates a new BigInt object using a specified sign bit and a
   * specified list of digits/words.
   * The resulting number is calculated as:
   *
   * (-1)^sign_bit * (words[0] * (2^64)^0 + words[1] * (2^64)^1 + ...)
   */
  static MaybeLocal<BigInt> NewFromWords(Local<Context> context, int sign_bit,
                                         int word_count, const uint64_t* words);

  /**
   * Returns the value of this BigInt as an unsigned 64-bit integer.
   * If `lossless` is provided, it will reflect whether the return value was
   * truncated or wrapped around. In particular, it is set to `false` if this
   * BigInt is negative.
   */
  uint64_t Uint64Value(bool* lossless = nullptr) const;

  /**
   * Returns the value of this BigInt as a signed 64-bit integer.
   * If `lossless` is provided, it will reflect whether this BigInt was
   * truncated or not.
   */
  int64_t Int64Value(bool* lossless = nullptr) const;

  /**
   * Returns the number of 64-bit words needed to store the result of
   * ToWordsArray().
   */
  int WordCount() const;

  /**
   * Writes the contents of this BigInt to a specified memory location.
   * `sign_bit` must be provided and will be set to 1 if this BigInt is
   * negative.
   * `*word_count` has to be initialized to the length of the `words` array.
   * Upon return, it will be set to the actual number of words that would
   * be needed to store this BigInt (i.e. the return value of `WordCount()`).
   */
  void ToWordsArray(int* sign_bit, int* word_count, uint64_t* words) const;

  V8_INLINE static BigInt* Cast(v8::Data* data) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(data);
#endif
    return static_cast<BigInt*>(data);
  }

 private:
  BigInt();
  static void CheckCast(v8::Data* that);
};

Local<String> String::Empty(Isolate* isolate) {
  using S = internal::Address;
  using I = internal::Internals;
  I::CheckInitialized(isolate);
  S* slot = I::GetRootSlot(isolate, I::kEmptyStringRootIndex);
  return Local<String>::FromSlot(slot);
}

String::ExternalStringResource* String::GetExternalStringResource() const {
  using A = internal::Address;
  using I = internal::Internals;
  A obj = internal::ValueHelper::ValueAsAddress(this);

  ExternalStringResource* result;
  if (I::IsExternalTwoByteString(I::GetInstanceType(obj))) {
    Isolate* isolate = I::GetIsolateForSandbox(obj);
    A value = I::ReadExternalPointerField<internal::kExternalStringResourceTag>(
        isolate, obj, I::kStringResourceOffset);
    result = reinterpret_cast<String::ExternalStringResource*>(value);
  } else {
    result = GetExternalStringResourceSlow();
  }
#ifdef V8_ENABLE_CHECKS
  VerifyExternalStringResource(result);
#endif
  return result;
}

String::ExternalStringResourceBase* String::GetExternalStringResourceBase(
    String::Encoding* encoding_out) const {
  using A = internal::Address;
  using I = internal::Internals;
  A obj = internal::ValueHelper::ValueAsAddress(this);
  int type = I::GetInstanceType(obj) & I::kStringRepresentationAndEncodingMask;
  *encoding_out = static_cast<Encoding>(type & I::kStringEncodingMask);
  ExternalStringResourceBase* resource;
  if (type == I::kExternalOneByteRepresentationTag ||
      type == I::kExternalTwoByteRepresentationTag) {
    Isolate* isolate = I::GetIsolateForSandbox(obj);
    A value = I::ReadExternalPointerField<internal::kExternalStringResourceTag>(
        isolate, obj, I::kStringResourceOffset);
    resource = reinterpret_cast<ExternalStringResourceBase*>(value);
  } else {
    resource = GetExternalStringResourceBaseSlow(encoding_out);
  }
#ifdef V8_ENABLE_CHECKS
  VerifyExternalStringResourceBase(resource, *encoding_out);
#endif
  return resource;
}

// --- Statics ---

V8_INLINE Local<Primitive> Undefined(Isolate* isolate) {
  using S = internal::Address;
  using I = internal::Internals;
  I::CheckInitialized(isolate);
  S* slot = I::GetRootSlot(isolate, I::kUndefinedValueRootIndex);
  return Local<Primitive>::FromSlot(slot);
}

V8_INLINE Local<Primitive> Null(Isolate* isolate) {
  using S = internal::Address;
  using I = internal::Internals;
  I::CheckInitialized(isolate);
  S* slot = I::GetRootSlot(isolate, I::kNullValueRootIndex);
  return Local<Primitive>::FromSlot(slot);
}

V8_INLINE Local<Boolean> True(Isolate* isolate) {
  using S = internal::Address;
  using I = internal::Internals;
  I::CheckInitialized(isolate);
  S* slot = I::GetRootSlot(isolate, I::kTrueValueRootIndex);
  return Local<Boolean>::FromSlot(slot);
}

V8_INLINE Local<Boolean> False(Isolate* isolate) {
  using S = internal::Address;
  using I = internal::Internals;
  I::CheckInitialized(isolate);
  S* slot = I::GetRootSlot(isolate, I::kFalseValueRootIndex);
  return Local<Boolean>::FromSlot(slot);
}

Local<Boolean> Boolean::New(Isolate* isolate, bool value) {
  return value ? True(isolate) : False(isolate);
}

}  // namespace v8

#endif  // INCLUDE_V8_PRIMITIVE_H_
