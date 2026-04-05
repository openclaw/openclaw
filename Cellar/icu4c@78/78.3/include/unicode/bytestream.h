// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
// Copyright (C) 2009-2012, International Business Machines
// Corporation and others. All Rights Reserved.
//
// Copyright 2007 Google Inc. All Rights Reserved.
// Author: sanjay@google.com (Sanjay Ghemawat)
//
// Abstract interface that consumes a sequence of bytes (ByteSink).
//
// Used so that we can write a single piece of code that can operate
// on a variety of output string types.
//
// Various implementations of this interface are provided:
//   ByteSink:
//      CheckedArrayByteSink    Write to a flat array, with bounds checking
//      StringByteSink          Write to an STL string

// This code is a contribution of Google code, and the style used here is
// a compromise between the original Google code and the ICU coding guidelines.
// For example, data types are ICU-ified (size_t,int->int32_t),
// and API comments doxygen-ified, but function names and behavior are
// as in the original, if possible.
// Assertion-style error handling, not available in ICU, was changed to
// parameter "pinning" similar to UnicodeString.
//
// In addition, this is only a partial port of the original Google code,
// limited to what was needed so far. The (nearly) complete original code
// is in the ICU svn repository at icuhtml/trunk/design/strings/contrib
// (see ICU ticket 6765, r25517).

#ifndef __BYTESTREAM_H__
#define __BYTESTREAM_H__

/**
 * \file
 * \brief C++ API: Interface for writing bytes, and implementation classes.
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include <type_traits>

#include "unicode/uobject.h"
#include "unicode/std_string.h"

U_NAMESPACE_BEGIN

/**
 * A ByteSink can be filled with bytes.
 * @stable ICU 4.2
 */
class U_COMMON_API ByteSink : public UMemory {
public:
  /**
   * Default constructor.
   * @stable ICU 4.2
   */
  ByteSink() { }
  /**
   * Virtual destructor.
   * @stable ICU 4.2
   */
  virtual ~ByteSink();

  /**
   * Append "bytes[0,n-1]" to this.
   * @param bytes the pointer to the bytes
   * @param n the number of bytes; must be non-negative
   * @stable ICU 4.2
   */
  virtual void Append(const char* bytes, int32_t n) = 0;

  /**
   * Appends n bytes to this. Same as Append().
   * Call AppendU8() with u8"string literals" which are const char * in C++11
   * but const char8_t * in C++20.
   * If the compiler does support char8_t as a distinct type,
   * then an AppendU8() overload for that is defined and will be chosen.
   *
   * @param bytes the pointer to the bytes
   * @param n the number of bytes; must be non-negative
   * @stable ICU 67
   */
  inline void AppendU8(const char* bytes, int32_t n) {
    Append(bytes, n);
  }

#if defined(__cpp_char8_t) || defined(U_IN_DOXYGEN)
  /**
   * Appends n bytes to this. Same as Append() but for a const char8_t * pointer.
   * Call AppendU8() with u8"string literals" which are const char * in C++11
   * but const char8_t * in C++20.
   * If the compiler does support char8_t as a distinct type,
   * then this AppendU8() overload for that is defined and will be chosen.
   *
   * @param bytes the pointer to the bytes
   * @param n the number of bytes; must be non-negative
   * @stable ICU 67
   */
  inline void AppendU8(const char8_t* bytes, int32_t n) {
    Append(reinterpret_cast<const char*>(bytes), n);
  }
#endif

  /**
   * Returns a writable buffer for appending and writes the buffer's capacity to
   * *result_capacity. Guarantees *result_capacity>=min_capacity.
   * May return a pointer to the caller-owned scratch buffer which must have
   * scratch_capacity>=min_capacity.
   * The returned buffer is only valid until the next operation
   * on this ByteSink.
   *
   * After writing at most *result_capacity bytes, call Append() with the
   * pointer returned from this function and the number of bytes written.
   * Many Append() implementations will avoid copying bytes if this function
   * returned an internal buffer.
   *
   * Partial usage example:
   *  int32_t capacity;
   *  char* buffer = sink->GetAppendBuffer(..., &capacity);
   *  ... Write n bytes into buffer, with n <= capacity.
   *  sink->Append(buffer, n);
   * In many implementations, that call to Append will avoid copying bytes.
   *
   * If the ByteSink allocates or reallocates an internal buffer, it should use
   * the desired_capacity_hint if appropriate.
   * If a caller cannot provide a reasonable guess at the desired capacity,
   * it should pass desired_capacity_hint=0.
   *
   * If a non-scratch buffer is returned, the caller may only pass
   * a prefix to it to Append().
   * That is, it is not correct to pass an interior pointer to Append().
   *
   * The default implementation always returns the scratch buffer.
   *
   * @param min_capacity required minimum capacity of the returned buffer;
   *                     must be non-negative
   * @param desired_capacity_hint desired capacity of the returned buffer;
   *                              must be non-negative
   * @param scratch default caller-owned buffer
   * @param scratch_capacity capacity of the scratch buffer
   * @param result_capacity pointer to an integer which will be set to the
   *                        capacity of the returned buffer
   * @return a buffer with *result_capacity>=min_capacity
   * @stable ICU 4.2
   */
  virtual char* GetAppendBuffer(int32_t min_capacity,
                                int32_t desired_capacity_hint,
                                char* scratch, int32_t scratch_capacity,
                                int32_t* result_capacity);

  /**
   * Flush internal buffers.
   * Some byte sinks use internal buffers or provide buffering
   * and require calling Flush() at the end of the stream.
   * The ByteSink should be ready for further Append() calls after Flush().
   * The default implementation of Flush() does nothing.
   * @stable ICU 4.2
   */
  virtual void Flush();

private:
  ByteSink(const ByteSink &) = delete;
  ByteSink &operator=(const ByteSink &) = delete;
};

// -------------------------------------------------------------
// Some standard implementations

/** 
 * Implementation of ByteSink that writes to a flat byte array,
 * with bounds-checking:
 * This sink will not write more than capacity bytes to outbuf.
 * If more than capacity bytes are Append()ed, then excess bytes are ignored,
 * and Overflowed() will return true.
 * Overflow does not cause a runtime error.
 * @stable ICU 4.2
 */
class U_COMMON_API CheckedArrayByteSink : public ByteSink {
public:
  /**
   * Constructs a ByteSink that will write to outbuf[0..capacity-1].
   * @param outbuf buffer to write to
   * @param capacity size of the buffer
   * @stable ICU 4.2
   */
  CheckedArrayByteSink(char* outbuf, int32_t capacity);
  /**
   * Destructor.
   * @stable ICU 4.2
   */
  virtual ~CheckedArrayByteSink();
  /**
   * Returns the sink to its original state, without modifying the buffer.
   * Useful for reusing both the buffer and the sink for multiple streams.
   * Resets the state to NumberOfBytesWritten()=NumberOfBytesAppended()=0
   * and Overflowed()=false.
   * @return *this
   * @stable ICU 4.6
   */
  virtual CheckedArrayByteSink& Reset();
  /**
   * Append "bytes[0,n-1]" to this.
   * @param bytes the pointer to the bytes
   * @param n the number of bytes; must be non-negative
   * @stable ICU 4.2
   */
  virtual void Append(const char* bytes, int32_t n) override;
  /**
   * Returns a writable buffer for appending and writes the buffer's capacity to
   * *result_capacity. For details see the base class documentation.
   * @param min_capacity required minimum capacity of the returned buffer;
   *                     must be non-negative
   * @param desired_capacity_hint desired capacity of the returned buffer;
   *                              must be non-negative
   * @param scratch default caller-owned buffer
   * @param scratch_capacity capacity of the scratch buffer
   * @param result_capacity pointer to an integer which will be set to the
   *                        capacity of the returned buffer
   * @return a buffer with *result_capacity>=min_capacity
   * @stable ICU 4.2
   */
  virtual char* GetAppendBuffer(int32_t min_capacity,
                                int32_t desired_capacity_hint,
                                char* scratch, int32_t scratch_capacity,
                                int32_t* result_capacity) override;
  /**
   * Returns the number of bytes actually written to the sink.
   * @return number of bytes written to the buffer
   * @stable ICU 4.2
   */
  int32_t NumberOfBytesWritten() const { return size_; }
  /**
   * Returns true if any bytes were discarded, i.e., if there was an
   * attempt to write more than 'capacity' bytes.
   * @return true if more than 'capacity' bytes were Append()ed
   * @stable ICU 4.2
   */
  UBool Overflowed() const { return overflowed_; }
  /**
   * Returns the number of bytes appended to the sink.
   * If Overflowed() then NumberOfBytesAppended()>NumberOfBytesWritten()
   * else they return the same number.
   * @return number of bytes written to the buffer
   * @stable ICU 4.6
   */
  int32_t NumberOfBytesAppended() const { return appended_; }
private:
  char* outbuf_;
  const int32_t capacity_;
  int32_t size_;
  int32_t appended_;
  UBool overflowed_;

  CheckedArrayByteSink() = delete;
  CheckedArrayByteSink(const CheckedArrayByteSink &) = delete;
  CheckedArrayByteSink &operator=(const CheckedArrayByteSink &) = delete;
};

namespace prv {
/** @internal */
template<typename StringClass, typename = void>
struct value_type_or_char {
  /** @internal */
  using type = char;
};
/** @internal */
template<typename StringClass>
struct value_type_or_char<StringClass, std::void_t<typename StringClass::value_type>> {
  /** @internal */
  using type = typename StringClass::value_type;
};
/** @internal */
template<typename StringClass>
using value_type_or_char_t = typename value_type_or_char<StringClass>::type;
}

/** 
 * Implementation of ByteSink that writes to a "string".
 * The StringClass is usually instantiated with a std::string or a std::u8string.
 * StringClass must have public member functions reserve(integer type), capacity(), length(), and
 * append(value type, integer type) with the same semantics as those of std::basic_string, and must
 * have an 8-bit value type.  If the value type is not char, it must be a public member type
 * StringClass::value_type.
 * @stable ICU 4.2
 */
template<typename StringClass>
class StringByteSink : public ByteSink {
  using Unit = typename prv::value_type_or_char_t<StringClass>;
 public:
  /**
   * Constructs a ByteSink that will append bytes to the dest string.
   * @param dest pointer to string object to append to
   * @stable ICU 4.2
   */
  StringByteSink(StringClass* dest) : dest_(dest) { }
  /**
   * Constructs a ByteSink that reserves append capacity and will append bytes to the dest string.
   * 
   * @param dest pointer to string object to append to
   * @param initialAppendCapacity capacity beyond dest->length() to be reserve()d
   * @stable ICU 60
   */
  StringByteSink(StringClass* dest, int32_t initialAppendCapacity) : dest_(dest) {
    if (initialAppendCapacity > 0 &&
        static_cast<uint32_t>(initialAppendCapacity) > dest->capacity() - dest->length()) {
      dest->reserve(dest->length() + initialAppendCapacity);
    }
  }
  /**
   * Append "bytes[0,n-1]" to this.
   * @param data the pointer to the bytes
   * @param n the number of bytes; must be non-negative
   * @stable ICU 4.2
   */
  virtual void Append(const char* data, int32_t n) override {
    if constexpr (std::is_same_v<Unit, char>) {
      dest_->append(data, n);
    } else {
      dest_->append(reinterpret_cast<const Unit*>(data), n);
    }
  }
 private:
  StringClass* dest_;

  StringByteSink() = delete;
  StringByteSink(const StringByteSink &) = delete;
  StringByteSink &operator=(const StringByteSink &) = delete;
};

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif  // __BYTESTREAM_H__
