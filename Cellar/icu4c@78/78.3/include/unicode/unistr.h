// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 1998-2016, International Business Machines
*   Corporation and others.  All Rights Reserved.
**********************************************************************
*
* File unistr.h
*
* Modification History:
*
*   Date        Name        Description
*   09/25/98    stephen     Creation.
*   11/11/98    stephen     Changed per 11/9 code review.
*   04/20/99    stephen     Overhauled per 4/16 code review.
*   11/18/99    aliu        Made to inherit from Replaceable.  Added method
*                           handleReplaceBetween(); other methods unchanged.
*   06/25/01    grhoten     Remove dependency on iostream.
******************************************************************************
*/

#ifndef UNISTR_H
#define UNISTR_H

/**
 * \file
 * \brief C++ API: Unicode String
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include <cstddef>
#include <string_view>
#include "unicode/char16ptr.h"
#include "unicode/rep.h"
#include "unicode/std_string.h"
#include "unicode/stringpiece.h"
#include "unicode/bytestream.h"

struct UConverter;          // unicode/ucnv.h

#ifndef USTRING_H
/**
 * \ingroup ustring_ustrlen
 * @param s Pointer to sequence of UChars.
 * @return Length of sequence.
 */
U_CAPI int32_t U_EXPORT2 u_strlen(const UChar *s);
#endif

U_NAMESPACE_BEGIN

#if !UCONFIG_NO_BREAK_ITERATION
class BreakIterator;        // unicode/brkiter.h
#endif
class Edits;

U_NAMESPACE_END

// Not #ifndef U_HIDE_INTERNAL_API because UnicodeString needs the UStringCaseMapper.
/**
 * Internal string case mapping function type.
 * All error checking must be done.
 * src and dest must not overlap.
 * @internal
 */
typedef int32_t U_CALLCONV
UStringCaseMapper(int32_t caseLocale, uint32_t options,
#if !UCONFIG_NO_BREAK_ITERATION
                  icu::BreakIterator *iter,
#endif
                  char16_t *dest, int32_t destCapacity,
                  const char16_t *src, int32_t srcLength,
                  icu::Edits *edits,
                  UErrorCode &errorCode);

U_NAMESPACE_BEGIN

class Locale;               // unicode/locid.h
class StringCharacterIterator;
class UnicodeStringAppendable;  // unicode/appendable.h

/* The <iostream> include has been moved to unicode/ustream.h */

/**
 * Constant to be used in the UnicodeString(char *, int32_t, EInvariant) constructor
 * which constructs a Unicode string from an invariant-character char * string.
 * About invariant characters see utypes.h.
 * This constructor has no runtime dependency on conversion code and is
 * therefore recommended over ones taking a charset name string
 * (where the empty string "" indicates invariant-character conversion).
 *
 * @stable ICU 3.2
 */
#define US_INV icu::UnicodeString::kInvariant

/**
 * \def UNICODE_STRING
 * Obsolete macro approximating UnicodeString literals.
 *
 * Prior to the availability of C++11 and u"UTF-16 string literals",
 * this macro was provided for portability and efficiency when
 * initializing UnicodeStrings from literals.
 *
 * Since C++17 and ICU 76, you can use UTF-16 string literals with compile-time
 * length determination:
 * \code
 * UnicodeString str(u"literal");
 * if (str == u"other literal") { ... }
 * \endcode
 *
 * The string parameter must be a C string literal.
 * The length of the string, not including the terminating
 * `NUL`, must be specified as a constant.
 * @stable ICU 2.0
 */
#if !U_CHAR16_IS_TYPEDEF
# define UNICODE_STRING(cs, _length) icu::UnicodeString(true, u ## cs, _length)
#else
# define UNICODE_STRING(cs, _length) icu::UnicodeString(true, (const char16_t*)u ## cs, _length)
#endif

/**
 * Unicode String literals in C++.
 * Obsolete macro approximating UnicodeString literals.
 * See UNICODE_STRING.
 *
 * The string parameter must be a C string literal.
 * @stable ICU 2.0
 * @see UNICODE_STRING
 */
#define UNICODE_STRING_SIMPLE(cs) UNICODE_STRING(cs, -1)

/**
 * \def UNISTR_FROM_CHAR_EXPLICIT
 * This can be defined to be empty or "explicit".
 * If explicit, then the UnicodeString(char16_t) and UnicodeString(UChar32)
 * constructors are marked as explicit, preventing their inadvertent use.
 * @stable ICU 49
 */
#ifndef UNISTR_FROM_CHAR_EXPLICIT
# if defined(U_COMBINED_IMPLEMENTATION) || defined(U_COMMON_IMPLEMENTATION) || defined(U_I18N_IMPLEMENTATION) || defined(U_IO_IMPLEMENTATION)
    // Auto-"explicit" in ICU library code.
#   define UNISTR_FROM_CHAR_EXPLICIT explicit
# else
    // Empty by default for source code compatibility.
#   define UNISTR_FROM_CHAR_EXPLICIT
# endif
#endif

/**
 * \def UNISTR_FROM_STRING_EXPLICIT
 * This can be defined to be empty or "explicit".
 * If explicit, then the UnicodeString(const char *) and UnicodeString(const char16_t *)
 * constructors are marked as explicit, preventing their inadvertent use.
 *
 * In particular, this helps prevent accidentally depending on ICU conversion code
 * by passing a string literal into an API with a const UnicodeString & parameter.
 * @stable ICU 49
 */
#ifndef UNISTR_FROM_STRING_EXPLICIT
# if defined(U_COMBINED_IMPLEMENTATION) || defined(U_COMMON_IMPLEMENTATION) || defined(U_I18N_IMPLEMENTATION) || defined(U_IO_IMPLEMENTATION)
    // Auto-"explicit" in ICU library code.
#   define UNISTR_FROM_STRING_EXPLICIT explicit
# else
    // Empty by default for source code compatibility.
#   define UNISTR_FROM_STRING_EXPLICIT
# endif
#endif

/**
 * \def UNISTR_OBJECT_SIZE
 * Desired sizeof(UnicodeString) in bytes.
 * It should be a multiple of sizeof(pointer) to avoid unusable space for padding.
 * The object size may want to be a multiple of 16 bytes,
 * which is a common granularity for heap allocation.
 *
 * Any space inside the object beyond sizeof(vtable pointer) + 2
 * is available for storing short strings inside the object.
 * The bigger the object, the longer a string that can be stored inside the object,
 * without additional heap allocation.
 *
 * Depending on a platform's pointer size, pointer alignment requirements,
 * and struct padding, the compiler will usually round up sizeof(UnicodeString)
 * to 4 * sizeof(pointer) (or 3 * sizeof(pointer) for P128 data models),
 * to hold the fields for heap-allocated strings.
 * Such a minimum size also ensures that the object is easily large enough
 * to hold at least 2 char16_ts, for one supplementary code point (U16_MAX_LENGTH).
 *
 * sizeof(UnicodeString) >= 48 should work for all known platforms.
 *
 * For example, on a 64-bit machine where sizeof(vtable pointer) is 8,
 * sizeof(UnicodeString) = 64 would leave space for
 * (64 - sizeof(vtable pointer) - 2) / U_SIZEOF_UCHAR = (64 - 8 - 2) / 2 = 27
 * char16_ts stored inside the object.
 *
 * The minimum object size on a 64-bit machine would be
 * 4 * sizeof(pointer) = 4 * 8 = 32 bytes,
 * and the internal buffer would hold up to 11 char16_ts in that case.
 *
 * @see U16_MAX_LENGTH
 * @stable ICU 56
 */
#ifndef UNISTR_OBJECT_SIZE
# define UNISTR_OBJECT_SIZE 64
#endif

/**
 * UnicodeString is a string class that stores Unicode characters directly and provides
 * similar functionality as the Java String and StringBuffer/StringBuilder classes.
 * It is a concrete implementation of the abstract class Replaceable (for transliteration).
 *
 * The UnicodeString equivalent of std::string’s clear() is remove().
 *
 * Starting with ICU 78, a UnicodeString is a C++ "range" of char16_t code units.
 * utfStringCodePoints() and unsafeUTFStringCodePoints() can be used to iterate over
 * the code points.
 *
 * A UnicodeString may "alias" an external array of characters
 * (that is, point to it, rather than own the array)
 * whose lifetime must then at least match the lifetime of the aliasing object.
 * This aliasing may be preserved when returning a UnicodeString by value,
 * depending on the compiler and the function implementation,
 * via Return Value Optimization (RVO) or the move assignment operator.
 * (However, the copy assignment operator does not preserve aliasing.)
 * For details see the description of storage models at the end of the class API docs
 * and in the User Guide chapter linked from there.
 *
 * The UnicodeString class is not suitable for subclassing.
 *
 * For an overview of Unicode strings in C and C++ see the
 * [User Guide Strings chapter](https://unicode-org.github.io/icu/userguide/strings#strings-in-cc).
 *
 * In ICU, a Unicode string consists of 16-bit Unicode *code units*.
 * A Unicode character may be stored with either one code unit
 * (the most common case) or with a matched pair of special code units
 * ("surrogates"). The data type for code units is char16_t.
 * For single-character handling, a Unicode character code *point* is a value
 * in the range 0..0x10ffff. ICU uses the UChar32 type for code points.
 *
 * Indexes and offsets into and lengths of strings always count code units, not code points.
 * This is the same as with multi-byte char* strings in traditional string handling.
 * Operations on partial strings typically do not test for code point boundaries.
 * If necessary, the user needs to take care of such boundaries by testing for the code unit
 * values or by using functions like
 * UnicodeString::getChar32Start() and UnicodeString::getChar32Limit()
 * (or, in C, the equivalent macros U16_SET_CP_START() and U16_SET_CP_LIMIT(), see utf.h).
 *
 * UnicodeString methods are more lenient with regard to input parameter values
 * than other ICU APIs. In particular:
 * - If indexes are out of bounds for a UnicodeString object
 *   (< 0 or > length()) then they are "pinned" to the nearest boundary.
 * - If the buffer passed to an insert/append/replace operation is owned by the
 *   target object, e.g., calling str.append(str), an extra copy may take place
 *   to ensure safety.
 * - If primitive string pointer values (e.g., const char16_t * or char *)
 *   for input strings are nullptr, then those input string parameters are treated
 *   as if they pointed to an empty string.
 *   However, this is *not* the case for char * parameters for charset names
 *   or other IDs.
 * - Most UnicodeString methods do not take a UErrorCode parameter because
 *   there are usually very few opportunities for failure other than a shortage
 *   of memory, error codes in low-level C++ string methods would be inconvenient,
 *   and the error code as the last parameter (ICU convention) would prevent
 *   the use of default parameter values.
 *   Instead, such methods set the UnicodeString into a "bogus" state
 *   (see isBogus()) if an error occurs.
 *
 * In string comparisons, two UnicodeString objects that are both "bogus"
 * compare equal (to be transitive and prevent endless loops in sorting),
 * and a "bogus" string compares less than any non-"bogus" one.
 *
 * Const UnicodeString methods are thread-safe. Multiple threads can use
 * const methods on the same UnicodeString object simultaneously,
 * but non-const methods must not be called concurrently (in multiple threads)
 * with any other (const or non-const) methods.
 *
 * Similarly, const UnicodeString & parameters are thread-safe.
 * One object may be passed in as such a parameter concurrently in multiple threads.
 * This includes the const UnicodeString & parameters for
 * copy construction, assignment, and cloning.
 *
 * UnicodeString uses several storage methods.
 * String contents can be stored inside the UnicodeString object itself,
 * in an allocated and shared buffer, or in an outside buffer that is "aliased".
 * Most of this is done transparently, but careful aliasing in particular provides
 * significant performance improvements.
 * Also, the internal buffer is accessible via special functions.
 * For details see the
 * [User Guide Strings chapter](https://unicode-org.github.io/icu/userguide/strings#maximizing-performance-with-the-unicodestring-storage-model).
 *
 * @see utf.h
 * @see utfiterator.h
 * @see utfStringCodePoints
 * @see unsafeUTFStringCodePoints
 * @see CharacterIterator
 * @stable ICU 2.0
 */
class U_COMMON_API UnicodeString : public Replaceable
{
public:
  /** C++ boilerplate @internal */
  using value_type = char16_t;

  /**
   * Constant to be used in the UnicodeString(char *, int32_t, EInvariant) constructor
   * which constructs a Unicode string from an invariant-character char * string.
   * Use the macro US_INV instead of the full qualification for this value.
   *
   * @see US_INV
   * @stable ICU 3.2
   */
  enum EInvariant {
    /**
     * @see EInvariant
     * @stable ICU 3.2
     */
    kInvariant
  };

  //========================================
  // Read-only operations
  //========================================

  /* Comparison - bitwise only - for international comparison use collation */

  /**
   * Equality operator. Performs only bitwise comparison.
   * @param text The UnicodeString to compare to this one.
   * @return true if `text` contains the same characters as this one,
   * false otherwise.
   * @stable ICU 2.0
   */
  inline bool operator== (const UnicodeString& text) const;

  /**
   * Equality operator. Performs only bitwise comparison with `text`
   * which is, or which is implicitly convertible to,
   * a std::u16string_view or (if U_SIZEOF_WCHAR_T==2) std::wstring_view.
   *
   * For performance, you can use UTF-16 string literals with compile-time
   * length determination:
   * \code
   * UnicodeString str = ...;
   * if (str == u"literal") { ... }
   * \endcode
   * @param text The string view to compare to this string.
   * @return true if `text` contains the same characters as this one, false otherwise.
   * @stable ICU 76
   */
  template<typename S, typename = std::enable_if_t<ConvertibleToU16StringView<S>>>
  inline bool operator==(const S &text) const {
    std::u16string_view sv(internal::toU16StringView(text));
    uint32_t len;  // unsigned to avoid a compiler warning
    return !isBogus() && (len = length()) == sv.length() && doEquals(sv.data(), len);
  }

  /**
   * Inequality operator. Performs only bitwise comparison.
   * @param text The UnicodeString to compare to this one.
   * @return false if `text` contains the same characters as this one,
   * true otherwise.
   * @stable ICU 2.0
   */
  inline bool operator!= (const UnicodeString& text) const;

  /**
   * Inequality operator. Performs only bitwise comparison with `text`
   * which is, or which is implicitly convertible to,
   * a std::u16string_view or (if U_SIZEOF_WCHAR_T==2) std::wstring_view.
   *
   * For performance, you can use std::u16string_view literals with compile-time
   * length determination:
   * \code
   * #include &lt;string_view&gt;
   * using namespace std::string_view_literals;
   * UnicodeString str = ...;
   * if (str != u"literal"sv) { ... }
   * \endcode
   * @param text The string view to compare to this string.
   * @return false if `text` contains the same characters as this one, true otherwise.
   * @stable ICU 76
   */
  template<typename S, typename = std::enable_if_t<ConvertibleToU16StringView<S>>>
  inline bool operator!=(const S &text) const {
    return !operator==(text);
  }

  /**
   * Greater than operator. Performs only bitwise comparison.
   * @param text The UnicodeString to compare to this one.
   * @return true if the characters in this are bitwise
   * greater than the characters in `text`, false otherwise
   * @stable ICU 2.0
   */
  inline UBool operator> (const UnicodeString& text) const;

  /**
   * Less than operator. Performs only bitwise comparison.
   * @param text The UnicodeString to compare to this one.
   * @return true if the characters in this are bitwise
   * less than the characters in `text`, false otherwise
   * @stable ICU 2.0
   */
  inline UBool operator< (const UnicodeString& text) const;

  /**
   * Greater than or equal operator. Performs only bitwise comparison.
   * @param text The UnicodeString to compare to this one.
   * @return true if the characters in this are bitwise
   * greater than or equal to the characters in `text`, false otherwise
   * @stable ICU 2.0
   */
  inline UBool operator>= (const UnicodeString& text) const;

  /**
   * Less than or equal operator. Performs only bitwise comparison.
   * @param text The UnicodeString to compare to this one.
   * @return true if the characters in this are bitwise
   * less than or equal to the characters in `text`, false otherwise
   * @stable ICU 2.0
   */
  inline UBool operator<= (const UnicodeString& text) const;

  /**
   * Compare the characters bitwise in this UnicodeString to
   * the characters in `text`.
   * @param text The UnicodeString to compare to this one.
   * @return The result of bitwise character comparison: 0 if this
   * contains the same characters as `text`, -1 if the characters in
   * this are bitwise less than the characters in `text`, +1 if the
   * characters in this are bitwise greater than the characters
   * in `text`.
   * @stable ICU 2.0
   */
  inline int8_t compare(const UnicodeString& text) const;

  /**
   * Compare the characters bitwise in the range
   * [`start`, `start + length`) with the characters
   * in the **entire string** `text`.
   * (The parameters "start" and "length" are not applied to the other text "text".)
   * @param start the offset at which the compare operation begins
   * @param length the number of characters of text to compare.
   * @param text the other text to be compared against this string.
   * @return The result of bitwise character comparison: 0 if this
   * contains the same characters as `text`, -1 if the characters in
   * this are bitwise less than the characters in `text`, +1 if the
   * characters in this are bitwise greater than the characters
   * in `text`.
   * @stable ICU 2.0
   */
  inline int8_t compare(int32_t start,
         int32_t length,
         const UnicodeString& text) const;

  /**
   * Compare the characters bitwise in the range
   * [`start`, `start + length`) with the characters
   * in `srcText` in the range
   * [`srcStart`, `srcStart + srcLength`).
   * @param start the offset at which the compare operation begins
   * @param length the number of characters in this to compare.
   * @param srcText the text to be compared
   * @param srcStart the offset into `srcText` to start comparison
   * @param srcLength the number of characters in `src` to compare
   * @return The result of bitwise character comparison: 0 if this
   * contains the same characters as `srcText`, -1 if the characters in
   * this are bitwise less than the characters in `srcText`, +1 if the
   * characters in this are bitwise greater than the characters
   * in `srcText`.
   * @stable ICU 2.0
   */
   inline int8_t compare(int32_t start,
         int32_t length,
         const UnicodeString& srcText,
         int32_t srcStart,
         int32_t srcLength) const;

  /**
   * Compare the characters bitwise in this UnicodeString with the first
   * `srcLength` characters in `srcChars`.
   * @param srcChars The characters to compare to this UnicodeString.
   * @param srcLength the number of characters in `srcChars` to compare
   * @return The result of bitwise character comparison: 0 if this
   * contains the same characters as `srcChars`, -1 if the characters in
   * this are bitwise less than the characters in `srcChars`, +1 if the
   * characters in this are bitwise greater than the characters
   * in `srcChars`.
   * @stable ICU 2.0
   */
  inline int8_t compare(ConstChar16Ptr srcChars,
         int32_t srcLength) const;

  /**
   * Compare the characters bitwise in the range
   * [`start`, `start + length`) with the first
   * `length` characters in `srcChars`
   * @param start the offset at which the compare operation begins
   * @param length the number of characters to compare.
   * @param srcChars the characters to be compared
   * @return The result of bitwise character comparison: 0 if this
   * contains the same characters as `srcChars`, -1 if the characters in
   * this are bitwise less than the characters in `srcChars`, +1 if the
   * characters in this are bitwise greater than the characters
   * in `srcChars`.
   * @stable ICU 2.0
   */
  inline int8_t compare(int32_t start,
         int32_t length,
         const char16_t *srcChars) const;

  /**
   * Compare the characters bitwise in the range
   * [`start`, `start + length`) with the characters
   * in `srcChars` in the range
   * [`srcStart`, `srcStart + srcLength`).
   * @param start the offset at which the compare operation begins
   * @param length the number of characters in this to compare
   * @param srcChars the characters to be compared
   * @param srcStart the offset into `srcChars` to start comparison
   * @param srcLength the number of characters in `srcChars` to compare
   * @return The result of bitwise character comparison: 0 if this
   * contains the same characters as `srcChars`, -1 if the characters in
   * this are bitwise less than the characters in `srcChars`, +1 if the
   * characters in this are bitwise greater than the characters
   * in `srcChars`.
   * @stable ICU 2.0
   */
  inline int8_t compare(int32_t start,
         int32_t length,
         const char16_t *srcChars,
         int32_t srcStart,
         int32_t srcLength) const;

  /**
   * Compare the characters bitwise in the range
   * [`start`, `limit`) with the characters
   * in `srcText` in the range
   * [`srcStart`, `srcLimit`).
   * @param start the offset at which the compare operation begins
   * @param limit the offset immediately following the compare operation
   * @param srcText the text to be compared
   * @param srcStart the offset into `srcText` to start comparison
   * @param srcLimit the offset into `srcText` to limit comparison
   * @return The result of bitwise character comparison: 0 if this
   * contains the same characters as `srcText`, -1 if the characters in
   * this are bitwise less than the characters in `srcText`, +1 if the
   * characters in this are bitwise greater than the characters
   * in `srcText`.
   * @stable ICU 2.0
   */
  inline int8_t compareBetween(int32_t start,
            int32_t limit,
            const UnicodeString& srcText,
            int32_t srcStart,
            int32_t srcLimit) const;

  /**
   * Compare two Unicode strings in code point order.
   * The result may be different from the results of compare(), operator<, etc.
   * if supplementary characters are present:
   *
   * In UTF-16, supplementary characters (with code points U+10000 and above) are
   * stored with pairs of surrogate code units. These have values from 0xd800 to 0xdfff,
   * which means that they compare as less than some other BMP characters like U+feff.
   * This function compares Unicode strings in code point order.
   * If either of the UTF-16 strings is malformed (i.e., it contains unpaired surrogates), then the result is not defined.
   *
   * @param text Another string to compare this one to.
   * @return a negative/zero/positive integer corresponding to whether
   * this string is less than/equal to/greater than the second one
   * in code point order
   * @stable ICU 2.0
   */
  inline int8_t compareCodePointOrder(const UnicodeString& text) const;

  /**
   * Compare two Unicode strings in code point order.
   * The result may be different from the results of compare(), operator<, etc.
   * if supplementary characters are present:
   *
   * In UTF-16, supplementary characters (with code points U+10000 and above) are
   * stored with pairs of surrogate code units. These have values from 0xd800 to 0xdfff,
   * which means that they compare as less than some other BMP characters like U+feff.
   * This function compares Unicode strings in code point order.
   * If either of the UTF-16 strings is malformed (i.e., it contains unpaired surrogates), then the result is not defined.
   *
   * @param start The start offset in this string at which the compare operation begins.
   * @param length The number of code units from this string to compare.
   * @param srcText Another string to compare this one to.
   * @return a negative/zero/positive integer corresponding to whether
   * this string is less than/equal to/greater than the second one
   * in code point order
   * @stable ICU 2.0
   */
  inline int8_t compareCodePointOrder(int32_t start,
                                      int32_t length,
                                      const UnicodeString& srcText) const;

  /**
   * Compare two Unicode strings in code point order.
   * The result may be different from the results of compare(), operator<, etc.
   * if supplementary characters are present:
   *
   * In UTF-16, supplementary characters (with code points U+10000 and above) are
   * stored with pairs of surrogate code units. These have values from 0xd800 to 0xdfff,
   * which means that they compare as less than some other BMP characters like U+feff.
   * This function compares Unicode strings in code point order.
   * If either of the UTF-16 strings is malformed (i.e., it contains unpaired surrogates), then the result is not defined.
   *
   * @param start The start offset in this string at which the compare operation begins.
   * @param length The number of code units from this string to compare.
   * @param srcText Another string to compare this one to.
   * @param srcStart The start offset in that string at which the compare operation begins.
   * @param srcLength The number of code units from that string to compare.
   * @return a negative/zero/positive integer corresponding to whether
   * this string is less than/equal to/greater than the second one
   * in code point order
   * @stable ICU 2.0
   */
   inline int8_t compareCodePointOrder(int32_t start,
                                       int32_t length,
                                       const UnicodeString& srcText,
                                       int32_t srcStart,
                                       int32_t srcLength) const;

  /**
   * Compare two Unicode strings in code point order.
   * The result may be different from the results of compare(), operator<, etc.
   * if supplementary characters are present:
   *
   * In UTF-16, supplementary characters (with code points U+10000 and above) are
   * stored with pairs of surrogate code units. These have values from 0xd800 to 0xdfff,
   * which means that they compare as less than some other BMP characters like U+feff.
   * This function compares Unicode strings in code point order.
   * If either of the UTF-16 strings is malformed (i.e., it contains unpaired surrogates), then the result is not defined.
   *
   * @param srcChars A pointer to another string to compare this one to.
   * @param srcLength The number of code units from that string to compare.
   * @return a negative/zero/positive integer corresponding to whether
   * this string is less than/equal to/greater than the second one
   * in code point order
   * @stable ICU 2.0
   */
  inline int8_t compareCodePointOrder(ConstChar16Ptr srcChars,
                                      int32_t srcLength) const;

  /**
   * Compare two Unicode strings in code point order.
   * The result may be different from the results of compare(), operator<, etc.
   * if supplementary characters are present:
   *
   * In UTF-16, supplementary characters (with code points U+10000 and above) are
   * stored with pairs of surrogate code units. These have values from 0xd800 to 0xdfff,
   * which means that they compare as less than some other BMP characters like U+feff.
   * This function compares Unicode strings in code point order.
   * If either of the UTF-16 strings is malformed (i.e., it contains unpaired surrogates), then the result is not defined.
   *
   * @param start The start offset in this string at which the compare operation begins.
   * @param length The number of code units from this string to compare.
   * @param srcChars A pointer to another string to compare this one to.
   * @return a negative/zero/positive integer corresponding to whether
   * this string is less than/equal to/greater than the second one
   * in code point order
   * @stable ICU 2.0
   */
  inline int8_t compareCodePointOrder(int32_t start,
                                      int32_t length,
                                      const char16_t *srcChars) const;

  /**
   * Compare two Unicode strings in code point order.
   * The result may be different from the results of compare(), operator<, etc.
   * if supplementary characters are present:
   *
   * In UTF-16, supplementary characters (with code points U+10000 and above) are
   * stored with pairs of surrogate code units. These have values from 0xd800 to 0xdfff,
   * which means that they compare as less than some other BMP characters like U+feff.
   * This function compares Unicode strings in code point order.
   * If either of the UTF-16 strings is malformed (i.e., it contains unpaired surrogates), then the result is not defined.
   *
   * @param start The start offset in this string at which the compare operation begins.
   * @param length The number of code units from this string to compare.
   * @param srcChars A pointer to another string to compare this one to.
   * @param srcStart The start offset in that string at which the compare operation begins.
   * @param srcLength The number of code units from that string to compare.
   * @return a negative/zero/positive integer corresponding to whether
   * this string is less than/equal to/greater than the second one
   * in code point order
   * @stable ICU 2.0
   */
  inline int8_t compareCodePointOrder(int32_t start,
                                      int32_t length,
                                      const char16_t *srcChars,
                                      int32_t srcStart,
                                      int32_t srcLength) const;

  /**
   * Compare two Unicode strings in code point order.
   * The result may be different from the results of compare(), operator<, etc.
   * if supplementary characters are present:
   *
   * In UTF-16, supplementary characters (with code points U+10000 and above) are
   * stored with pairs of surrogate code units. These have values from 0xd800 to 0xdfff,
   * which means that they compare as less than some other BMP characters like U+feff.
   * This function compares Unicode strings in code point order.
   * If either of the UTF-16 strings is malformed (i.e., it contains unpaired surrogates), then the result is not defined.
   *
   * @param start The start offset in this string at which the compare operation begins.
   * @param limit The offset after the last code unit from this string to compare.
   * @param srcText Another string to compare this one to.
   * @param srcStart The start offset in that string at which the compare operation begins.
   * @param srcLimit The offset after the last code unit from that string to compare.
   * @return a negative/zero/positive integer corresponding to whether
   * this string is less than/equal to/greater than the second one
   * in code point order
   * @stable ICU 2.0
   */
  inline int8_t compareCodePointOrderBetween(int32_t start,
                                             int32_t limit,
                                             const UnicodeString& srcText,
                                             int32_t srcStart,
                                             int32_t srcLimit) const;

  /**
   * Compare two strings case-insensitively using full case folding.
   * This is equivalent to this->foldCase(options).compare(text.foldCase(options)).
   *
   * @param text Another string to compare this one to.
   * @param options A bit set of options:
   *   - U_FOLD_CASE_DEFAULT or 0 is used for default options:
   *     Comparison in code unit order with default case folding.
   *
   *   - U_COMPARE_CODE_POINT_ORDER
   *     Set to choose code point order instead of code unit order
   *     (see u_strCompare for details).
   *
   *   - U_FOLD_CASE_EXCLUDE_SPECIAL_I
   *
   * @return A negative, zero, or positive integer indicating the comparison result.
   * @stable ICU 2.0
   */
  inline int8_t caseCompare(const UnicodeString& text, uint32_t options) const;

  /**
   * Compare two strings case-insensitively using full case folding.
   * This is equivalent to this->foldCase(options).compare(srcText.foldCase(options)).
   *
   * @param start The start offset in this string at which the compare operation begins.
   * @param length The number of code units from this string to compare.
   * @param srcText Another string to compare this one to.
   * @param options A bit set of options:
   *   - U_FOLD_CASE_DEFAULT or 0 is used for default options:
   *     Comparison in code unit order with default case folding.
   *
   *   - U_COMPARE_CODE_POINT_ORDER
   *     Set to choose code point order instead of code unit order
   *     (see u_strCompare for details).
   *
   *   - U_FOLD_CASE_EXCLUDE_SPECIAL_I
   *
   * @return A negative, zero, or positive integer indicating the comparison result.
   * @stable ICU 2.0
   */
  inline int8_t caseCompare(int32_t start,
         int32_t length,
         const UnicodeString& srcText,
         uint32_t options) const;

  /**
   * Compare two strings case-insensitively using full case folding.
   * This is equivalent to this->foldCase(options).compare(srcText.foldCase(options)).
   *
   * @param start The start offset in this string at which the compare operation begins.
   * @param length The number of code units from this string to compare.
   * @param srcText Another string to compare this one to.
   * @param srcStart The start offset in that string at which the compare operation begins.
   * @param srcLength The number of code units from that string to compare.
   * @param options A bit set of options:
   *   - U_FOLD_CASE_DEFAULT or 0 is used for default options:
   *     Comparison in code unit order with default case folding.
   *
   *   - U_COMPARE_CODE_POINT_ORDER
   *     Set to choose code point order instead of code unit order
   *     (see u_strCompare for details).
   *
   *   - U_FOLD_CASE_EXCLUDE_SPECIAL_I
   *
   * @return A negative, zero, or positive integer indicating the comparison result.
   * @stable ICU 2.0
   */
  inline int8_t caseCompare(int32_t start,
         int32_t length,
         const UnicodeString& srcText,
         int32_t srcStart,
         int32_t srcLength,
         uint32_t options) const;

  /**
   * Compare two strings case-insensitively using full case folding.
   * This is equivalent to this->foldCase(options).compare(srcChars.foldCase(options)).
   *
   * @param srcChars A pointer to another string to compare this one to.
   * @param srcLength The number of code units from that string to compare.
   * @param options A bit set of options:
   *   - U_FOLD_CASE_DEFAULT or 0 is used for default options:
   *     Comparison in code unit order with default case folding.
   *
   *   - U_COMPARE_CODE_POINT_ORDER
   *     Set to choose code point order instead of code unit order
   *     (see u_strCompare for details).
   *
   *   - U_FOLD_CASE_EXCLUDE_SPECIAL_I
   *
   * @return A negative, zero, or positive integer indicating the comparison result.
   * @stable ICU 2.0
   */
  inline int8_t caseCompare(ConstChar16Ptr srcChars,
         int32_t srcLength,
         uint32_t options) const;

  /**
   * Compare two strings case-insensitively using full case folding.
   * This is equivalent to this->foldCase(options).compare(srcChars.foldCase(options)).
   *
   * @param start The start offset in this string at which the compare operation begins.
   * @param length The number of code units from this string to compare.
   * @param srcChars A pointer to another string to compare this one to.
   * @param options A bit set of options:
   *   - U_FOLD_CASE_DEFAULT or 0 is used for default options:
   *     Comparison in code unit order with default case folding.
   *
   *   - U_COMPARE_CODE_POINT_ORDER
   *     Set to choose code point order instead of code unit order
   *     (see u_strCompare for details).
   *
   *   - U_FOLD_CASE_EXCLUDE_SPECIAL_I
   *
   * @return A negative, zero, or positive integer indicating the comparison result.
   * @stable ICU 2.0
   */
  inline int8_t caseCompare(int32_t start,
         int32_t length,
         const char16_t *srcChars,
         uint32_t options) const;

  /**
   * Compare two strings case-insensitively using full case folding.
   * This is equivalent to this->foldCase(options).compare(srcChars.foldCase(options)).
   *
   * @param start The start offset in this string at which the compare operation begins.
   * @param length The number of code units from this string to compare.
   * @param srcChars A pointer to another string to compare this one to.
   * @param srcStart The start offset in that string at which the compare operation begins.
   * @param srcLength The number of code units from that string to compare.
   * @param options A bit set of options:
   *   - U_FOLD_CASE_DEFAULT or 0 is used for default options:
   *     Comparison in code unit order with default case folding.
   *
   *   - U_COMPARE_CODE_POINT_ORDER
   *     Set to choose code point order instead of code unit order
   *     (see u_strCompare for details).
   *
   *   - U_FOLD_CASE_EXCLUDE_SPECIAL_I
   *
   * @return A negative, zero, or positive integer indicating the comparison result.
   * @stable ICU 2.0
   */
  inline int8_t caseCompare(int32_t start,
         int32_t length,
         const char16_t *srcChars,
         int32_t srcStart,
         int32_t srcLength,
         uint32_t options) const;

  /**
   * Compare two strings case-insensitively using full case folding.
   * This is equivalent to this->foldCase(options).compareBetween(text.foldCase(options)).
   *
   * @param start The start offset in this string at which the compare operation begins.
   * @param limit The offset after the last code unit from this string to compare.
   * @param srcText Another string to compare this one to.
   * @param srcStart The start offset in that string at which the compare operation begins.
   * @param srcLimit The offset after the last code unit from that string to compare.
   * @param options A bit set of options:
   *   - U_FOLD_CASE_DEFAULT or 0 is used for default options:
   *     Comparison in code unit order with default case folding.
   *
   *   - U_COMPARE_CODE_POINT_ORDER
   *     Set to choose code point order instead of code unit order
   *     (see u_strCompare for details).
   *
   *   - U_FOLD_CASE_EXCLUDE_SPECIAL_I
   *
   * @return A negative, zero, or positive integer indicating the comparison result.
   * @stable ICU 2.0
   */
  inline int8_t caseCompareBetween(int32_t start,
            int32_t limit,
            const UnicodeString& srcText,
            int32_t srcStart,
            int32_t srcLimit,
            uint32_t options) const;

  /**
   * Determine if this starts with the characters in `text`
   * @param text The text to match.
   * @return true if this starts with the characters in `text`,
   * false otherwise
   * @stable ICU 2.0
   */
  inline UBool startsWith(const UnicodeString& text) const;

  /**
   * Determine if this starts with the characters in `srcText`
   * in the range [`srcStart`, `srcStart + srcLength`).
   * @param srcText The text to match.
   * @param srcStart the offset into `srcText` to start matching
   * @param srcLength the number of characters in `srcText` to match
   * @return true if this starts with the characters in `text`,
   * false otherwise
   * @stable ICU 2.0
   */
  inline UBool startsWith(const UnicodeString& srcText,
            int32_t srcStart,
            int32_t srcLength) const;

  /**
   * Determine if this starts with the characters in `srcChars`
   * @param srcChars The characters to match.
   * @param srcLength the number of characters in `srcChars`
   * @return true if this starts with the characters in `srcChars`,
   * false otherwise
   * @stable ICU 2.0
   */
  inline UBool startsWith(ConstChar16Ptr srcChars,
            int32_t srcLength) const;

  /**
   * Determine if this ends with the characters in `srcChars`
   * in the range  [`srcStart`, `srcStart + srcLength`).
   * @param srcChars The characters to match.
   * @param srcStart the offset into `srcText` to start matching
   * @param srcLength the number of characters in `srcChars` to match
   * @return true if this ends with the characters in `srcChars`, false otherwise
   * @stable ICU 2.0
   */
  inline UBool startsWith(const char16_t *srcChars,
            int32_t srcStart,
            int32_t srcLength) const;

  /**
   * Determine if this ends with the characters in `text`
   * @param text The text to match.
   * @return true if this ends with the characters in `text`,
   * false otherwise
   * @stable ICU 2.0
   */
  inline UBool endsWith(const UnicodeString& text) const;

  /**
   * Determine if this ends with the characters in `srcText`
   * in the range [`srcStart`, `srcStart + srcLength`).
   * @param srcText The text to match.
   * @param srcStart the offset into `srcText` to start matching
   * @param srcLength the number of characters in `srcText` to match
   * @return true if this ends with the characters in `text`,
   * false otherwise
   * @stable ICU 2.0
   */
  inline UBool endsWith(const UnicodeString& srcText,
          int32_t srcStart,
          int32_t srcLength) const;

  /**
   * Determine if this ends with the characters in `srcChars`
   * @param srcChars The characters to match.
   * @param srcLength the number of characters in `srcChars`
   * @return true if this ends with the characters in `srcChars`,
   * false otherwise
   * @stable ICU 2.0
   */
  inline UBool endsWith(ConstChar16Ptr srcChars,
          int32_t srcLength) const;

  /**
   * Determine if this ends with the characters in `srcChars`
   * in the range  [`srcStart`, `srcStart + srcLength`).
   * @param srcChars The characters to match.
   * @param srcStart the offset into `srcText` to start matching
   * @param srcLength the number of characters in `srcChars` to match
   * @return true if this ends with the characters in `srcChars`,
   * false otherwise
   * @stable ICU 2.0
   */
  inline UBool endsWith(const char16_t *srcChars,
          int32_t srcStart,
          int32_t srcLength) const;


  /* Searching - bitwise only */

  /**
   * Locate in this the first occurrence of the characters in `text`,
   * using bitwise comparison.
   * @param text The text to search for.
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(const UnicodeString& text) const;

  /**
   * Locate in this the first occurrence of the characters in `text`
   * starting at offset `start`, using bitwise comparison.
   * @param text The text to search for.
   * @param start The offset at which searching will start.
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(const UnicodeString& text,
              int32_t start) const;

  /**
   * Locate in this the first occurrence in the range
   * [`start`, `start + length`) of the characters
   * in `text`, using bitwise comparison.
   * @param text The text to search for.
   * @param start The offset at which searching will start.
   * @param length The number of characters to search
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(const UnicodeString& text,
              int32_t start,
              int32_t length) const;

  /**
   * Locate in this the first occurrence in the range
   * [`start`, `start + length`) of the characters
   *  in `srcText` in the range
   * [`srcStart`, `srcStart + srcLength`),
   * using bitwise comparison.
   * @param srcText The text to search for.
   * @param srcStart the offset into `srcText` at which
   * to start matching
   * @param srcLength the number of characters in `srcText` to match
   * @param start the offset into this at which to start matching
   * @param length the number of characters in this to search
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(const UnicodeString& srcText,
              int32_t srcStart,
              int32_t srcLength,
              int32_t start,
              int32_t length) const;

  /**
   * Locate in this the first occurrence of the characters in
   * `srcChars`
   * starting at offset `start`, using bitwise comparison.
   * @param srcChars The text to search for.
   * @param srcLength the number of characters in `srcChars` to match
   * @param start the offset into this at which to start matching
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(const char16_t *srcChars,
              int32_t srcLength,
              int32_t start) const;

  /**
   * Locate in this the first occurrence in the range
   * [`start`, `start + length`) of the characters
   * in `srcChars`, using bitwise comparison.
   * @param srcChars The text to search for.
   * @param srcLength the number of characters in `srcChars`
   * @param start The offset at which searching will start.
   * @param length The number of characters to search
   * @return The offset into this of the start of `srcChars`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(ConstChar16Ptr srcChars,
              int32_t srcLength,
              int32_t start,
              int32_t length) const;

  /**
   * Locate in this the first occurrence in the range
   * [`start`, `start + length`) of the characters
   * in `srcChars` in the range
   * [`srcStart`, `srcStart + srcLength`),
   * using bitwise comparison.
   * @param srcChars The text to search for.
   * @param srcStart the offset into `srcChars` at which
   * to start matching
   * @param srcLength the number of characters in `srcChars` to match
   * @param start the offset into this at which to start matching
   * @param length the number of characters in this to search
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  int32_t indexOf(const char16_t *srcChars,
              int32_t srcStart,
              int32_t srcLength,
              int32_t start,
              int32_t length) const;

  /**
   * Locate in this the first occurrence of the BMP code point `c`,
   * using bitwise comparison.
   * @param c The code unit to search for.
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(char16_t c) const;

  /**
   * Locate in this the first occurrence of the code point `c`,
   * using bitwise comparison.
   *
   * @param c The code point to search for.
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(UChar32 c) const;

  /**
   * Locate in this the first occurrence of the BMP code point `c`,
   * starting at offset `start`, using bitwise comparison.
   * @param c The code unit to search for.
   * @param start The offset at which searching will start.
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(char16_t c,
              int32_t start) const;

  /**
   * Locate in this the first occurrence of the code point `c`
   * starting at offset `start`, using bitwise comparison.
   *
   * @param c The code point to search for.
   * @param start The offset at which searching will start.
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(UChar32 c,
              int32_t start) const;

  /**
   * Locate in this the first occurrence of the BMP code point `c`
   * in the range [`start`, `start + length`),
   * using bitwise comparison.
   * @param c The code unit to search for.
   * @param start the offset into this at which to start matching
   * @param length the number of characters in this to search
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(char16_t c,
              int32_t start,
              int32_t length) const;

  /**
   * Locate in this the first occurrence of the code point `c`
   * in the range [`start`, `start + length`),
   * using bitwise comparison.
   *
   * @param c The code point to search for.
   * @param start the offset into this at which to start matching
   * @param length the number of characters in this to search
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t indexOf(UChar32 c,
              int32_t start,
              int32_t length) const;

  /**
   * Locate in this the last occurrence of the characters in `text`,
   * using bitwise comparison.
   * @param text The text to search for.
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(const UnicodeString& text) const;

  /**
   * Locate in this the last occurrence of the characters in `text`
   * starting at offset `start`, using bitwise comparison.
   * @param text The text to search for.
   * @param start The offset at which searching will start.
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(const UnicodeString& text,
              int32_t start) const;

  /**
   * Locate in this the last occurrence in the range
   * [`start`, `start + length`) of the characters
   * in `text`, using bitwise comparison.
   * @param text The text to search for.
   * @param start The offset at which searching will start.
   * @param length The number of characters to search
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(const UnicodeString& text,
              int32_t start,
              int32_t length) const;

  /**
   * Locate in this the last occurrence in the range
   * [`start`, `start + length`) of the characters
   * in `srcText` in the range
   * [`srcStart`, `srcStart + srcLength`),
   * using bitwise comparison.
   * @param srcText The text to search for.
   * @param srcStart the offset into `srcText` at which
   * to start matching
   * @param srcLength the number of characters in `srcText` to match
   * @param start the offset into this at which to start matching
   * @param length the number of characters in this to search
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(const UnicodeString& srcText,
              int32_t srcStart,
              int32_t srcLength,
              int32_t start,
              int32_t length) const;

  /**
   * Locate in this the last occurrence of the characters in `srcChars`
   * starting at offset `start`, using bitwise comparison.
   * @param srcChars The text to search for.
   * @param srcLength the number of characters in `srcChars` to match
   * @param start the offset into this at which to start matching
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(const char16_t *srcChars,
              int32_t srcLength,
              int32_t start) const;

  /**
   * Locate in this the last occurrence in the range
   * [`start`, `start + length`) of the characters
   * in `srcChars`, using bitwise comparison.
   * @param srcChars The text to search for.
   * @param srcLength the number of characters in `srcChars`
   * @param start The offset at which searching will start.
   * @param length The number of characters to search
   * @return The offset into this of the start of `srcChars`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(ConstChar16Ptr srcChars,
              int32_t srcLength,
              int32_t start,
              int32_t length) const;

  /**
   * Locate in this the last occurrence in the range
   * [`start`, `start + length`) of the characters
   * in `srcChars` in the range
   * [`srcStart`, `srcStart + srcLength`),
   * using bitwise comparison.
   * @param srcChars The text to search for.
   * @param srcStart the offset into `srcChars` at which
   * to start matching
   * @param srcLength the number of characters in `srcChars` to match
   * @param start the offset into this at which to start matching
   * @param length the number of characters in this to search
   * @return The offset into this of the start of `text`,
   * or -1 if not found.
   * @stable ICU 2.0
   */
  int32_t lastIndexOf(const char16_t *srcChars,
              int32_t srcStart,
              int32_t srcLength,
              int32_t start,
              int32_t length) const;

  /**
   * Locate in this the last occurrence of the BMP code point `c`,
   * using bitwise comparison.
   * @param c The code unit to search for.
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(char16_t c) const;

  /**
   * Locate in this the last occurrence of the code point `c`,
   * using bitwise comparison.
   *
   * @param c The code point to search for.
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(UChar32 c) const;

  /**
   * Locate in this the last occurrence of the BMP code point `c`
   * starting at offset `start`, using bitwise comparison.
   * @param c The code unit to search for.
   * @param start The offset at which searching will start.
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(char16_t c,
              int32_t start) const;

  /**
   * Locate in this the last occurrence of the code point `c`
   * starting at offset `start`, using bitwise comparison.
   *
   * @param c The code point to search for.
   * @param start The offset at which searching will start.
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(UChar32 c,
              int32_t start) const;

  /**
   * Locate in this the last occurrence of the BMP code point `c`
   * in the range [`start`, `start + length`),
   * using bitwise comparison.
   * @param c The code unit to search for.
   * @param start the offset into this at which to start matching
   * @param length the number of characters in this to search
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(char16_t c,
              int32_t start,
              int32_t length) const;

  /**
   * Locate in this the last occurrence of the code point `c`
   * in the range [`start`, `start + length`),
   * using bitwise comparison.
   *
   * @param c The code point to search for.
   * @param start the offset into this at which to start matching
   * @param length the number of characters in this to search
   * @return The offset into this of `c`, or -1 if not found.
   * @stable ICU 2.0
   */
  inline int32_t lastIndexOf(UChar32 c,
              int32_t start,
              int32_t length) const;


  /* Character access */

  /**
   * Return the code unit at offset `offset`.
   * If the offset is not valid (0..length()-1) then U+ffff is returned.
   * @param offset a valid offset into the text
   * @return the code unit at offset `offset`
   *         or 0xffff if the offset is not valid for this string
   * @stable ICU 2.0
   */
  inline char16_t charAt(int32_t offset) const;

  /**
   * Return the code unit at offset `offset`.
   * If the offset is not valid (0..length()-1) then U+ffff is returned.
   * @param offset a valid offset into the text
   * @return the code unit at offset `offset`
   * @stable ICU 2.0
   */
  inline char16_t operator[] (int32_t offset) const;

  /**
   * Return the code point that contains the code unit
   * at offset `offset`.
   * If the offset is not valid (0..length()-1) then U+ffff is returned.
   * @param offset a valid offset into the text
   * that indicates the text offset of any of the code units
   * that will be assembled into a code point (21-bit value) and returned
   * @return the code point of text at `offset`
   *         or 0xffff if the offset is not valid for this string
   * @stable ICU 2.0
   */
  UChar32 char32At(int32_t offset) const;

  /**
   * Adjust a random-access offset so that
   * it points to the beginning of a Unicode character.
   * The offset that is passed in points to
   * any code unit of a code point,
   * while the returned offset will point to the first code unit
   * of the same code point.
   * In UTF-16, if the input offset points to a second surrogate
   * of a surrogate pair, then the returned offset will point
   * to the first surrogate.
   * @param offset a valid offset into one code point of the text
   * @return offset of the first code unit of the same code point
   * @see U16_SET_CP_START
   * @stable ICU 2.0
   */
  int32_t getChar32Start(int32_t offset) const;

  /**
   * Adjust a random-access offset so that
   * it points behind a Unicode character.
   * The offset that is passed in points behind
   * any code unit of a code point,
   * while the returned offset will point behind the last code unit
   * of the same code point.
   * In UTF-16, if the input offset points behind the first surrogate
   * (i.e., to the second surrogate)
   * of a surrogate pair, then the returned offset will point
   * behind the second surrogate (i.e., to the first surrogate).
   * @param offset a valid offset after any code unit of a code point of the text
   * @return offset of the first code unit after the same code point
   * @see U16_SET_CP_LIMIT
   * @stable ICU 2.0
   */
  int32_t getChar32Limit(int32_t offset) const;

  /**
   * Move the code unit index along the string by delta code points.
   * Interpret the input index as a code unit-based offset into the string,
   * move the index forward or backward by delta code points, and
   * return the resulting index.
   * The input index should point to the first code unit of a code point,
   * if there is more than one.
   *
   * Both input and output indexes are code unit-based as for all
   * string indexes/offsets in ICU (and other libraries, like MBCS char*).
   * If delta<0 then the index is moved backward (toward the start of the string).
   * If delta>0 then the index is moved forward (toward the end of the string).
   *
   * This behaves like CharacterIterator::move32(delta, kCurrent).
   *
   * Behavior for out-of-bounds indexes:
   * `moveIndex32` pins the input index to 0..length(), i.e.,
   * if the input index<0 then it is pinned to 0;
   * if it is index>length() then it is pinned to length().
   * Afterwards, the index is moved by `delta` code points
   * forward or backward,
   * but no further backward than to 0 and no further forward than to length().
   * The resulting index return value will be in between 0 and length(), inclusively.
   *
   * Examples:
   * \code
   *     // s has code points 'a' U+10000 'b' U+10ffff U+2029
   *     UnicodeString s(u"a\U00010000b\U0010ffff\u2029");
   *
   *     // initial index: position of U+10000
   *     int32_t index=1;
   *
   *     // the following examples will all result in index==4, position of U+10ffff
   *
   *     // skip 2 code points from some position in the string
   *     index=s.moveIndex32(index, 2); // skips U+10000 and 'b'
   *
   *     // go to the 3rd code point from the start of s (0-based)
   *     index=s.moveIndex32(0, 3); // skips 'a', U+10000, and 'b'
   *
   *     // go to the next-to-last code point of s
   *     index=s.moveIndex32(s.length(), -2); // backward-skips U+2029 and U+10ffff
   * \endcode
   *
   * @param index input code unit index
   * @param delta (signed) code point count to move the index forward or backward
   *        in the string
   * @return the resulting code unit index
   * @stable ICU 2.0
   */
  int32_t moveIndex32(int32_t index, int32_t delta) const;

  /* Substring extraction */

  /**
   * Copy the characters in the range
   * [`start`, `start + length`) into the array `dst`,
   * beginning at `dstStart`.
   * If the string aliases to `dst` itself as an external buffer,
   * then extract() will not copy the contents.
   *
   * @param start offset of first character which will be copied into the array
   * @param length the number of characters to extract
   * @param dst array in which to copy characters.  The length of `dst`
   * must be at least (`dstStart + length`).
   * @param dstStart the offset in `dst` where the first character
   * will be extracted
   * @stable ICU 2.0
   */
  inline void extract(int32_t start,
           int32_t length,
           Char16Ptr dst,
           int32_t dstStart = 0) const;

  /**
   * Copy the contents of the string into dest.
   * This is a convenience function that
   * checks if there is enough space in dest,
   * extracts the entire string if possible,
   * and NUL-terminates dest if possible.
   *
   * If the string fits into dest but cannot be NUL-terminated
   * (length()==destCapacity) then the error code is set to U_STRING_NOT_TERMINATED_WARNING.
   * If the string itself does not fit into dest
   * (length()>destCapacity) then the error code is set to U_BUFFER_OVERFLOW_ERROR.
   *
   * If the string aliases to `dest` itself as an external buffer,
   * then extract() will not copy the contents.
   *
   * @param dest Destination string buffer.
   * @param destCapacity Number of char16_ts available at dest.
   * @param errorCode ICU error code.
   * @return length()
   * @stable ICU 2.0
   */
  int32_t
  extract(Char16Ptr dest, int32_t destCapacity,
          UErrorCode &errorCode) const;

  /**
   * Copy the characters in the range
   * [`start`, `start + length`) into the  UnicodeString
   * `target`.
   * @param start offset of first character which will be copied
   * @param length the number of characters to extract
   * @param target UnicodeString into which to copy characters.
   * @stable ICU 2.0
   */
  inline void extract(int32_t start,
           int32_t length,
           UnicodeString& target) const;

  /**
   * Copy the characters in the range [`start`, `limit`)
   * into the array `dst`, beginning at `dstStart`.
   * @param start offset of first character which will be copied into the array
   * @param limit offset immediately following the last character to be copied
   * @param dst array in which to copy characters.  The length of `dst`
   * must be at least (`dstStart + (limit - start)`).
   * @param dstStart the offset in `dst` where the first character
   * will be extracted
   * @stable ICU 2.0
   */
  inline void extractBetween(int32_t start,
              int32_t limit,
              char16_t *dst,
              int32_t dstStart = 0) const;

  /**
   * Copy the characters in the range [`start`, `limit`)
   * into the UnicodeString `target`.  Replaceable API.
   * @param start offset of first character which will be copied
   * @param limit offset immediately following the last character to be copied
   * @param target UnicodeString into which to copy characters.
   * @stable ICU 2.0
   */
  virtual void extractBetween(int32_t start,
              int32_t limit,
              UnicodeString& target) const override;

  /**
   * Copy the characters in the range
   * [`start`, `start + startLength`) into an array of characters.
   * All characters must be invariant (see utypes.h).
   * Use US_INV as the last, signature-distinguishing parameter.
   *
   * This function does not write any more than `targetCapacity`
   * characters but returns the length of the entire output string
   * so that one can allocate a larger buffer and call the function again
   * if necessary.
   * The output string is NUL-terminated if possible.
   *
   * @param start offset of first character which will be copied
   * @param startLength the number of characters to extract
   * @param target the target buffer for extraction, can be nullptr
   *               if targetLength is 0
   * @param targetCapacity the length of the target buffer
   * @param inv Signature-distinguishing parameter, use US_INV.
   * @return the output string length, not including the terminating NUL
   * @stable ICU 3.2
   */
  int32_t extract(int32_t start,
           int32_t startLength,
           char *target,
           int32_t targetCapacity,
           enum EInvariant inv) const;

#if U_CHARSET_IS_UTF8 || !UCONFIG_NO_CONVERSION

  /**
   * Copy the characters in the range
   * [`start`, `start + length`) into an array of characters
   * in the platform's default codepage.
   * This function does not write any more than `targetLength`
   * characters but returns the length of the entire output string
   * so that one can allocate a larger buffer and call the function again
   * if necessary.
   * The output string is NUL-terminated if possible.
   *
   * @param start offset of first character which will be copied
   * @param startLength the number of characters to extract
   * @param target the target buffer for extraction
   * @param targetLength the length of the target buffer
   * If `target` is nullptr, then the number of bytes required for
   * `target` is returned.
   * @return the output string length, not including the terminating NUL
   * @stable ICU 2.0
   */
  int32_t extract(int32_t start,
           int32_t startLength,
           char *target,
           uint32_t targetLength) const;

#endif

#if !UCONFIG_NO_CONVERSION

  /**
   * Copy the characters in the range
   * [`start`, `start + length`) into an array of characters
   * in a specified codepage.
   * The output string is NUL-terminated.
   *
   * Recommendation: For invariant-character strings use
   * extract(int32_t start, int32_t length, char *target, int32_t targetCapacity, enum EInvariant inv) const
   * because it avoids object code dependencies of UnicodeString on
   * the conversion code.
   *
   * @param start offset of first character which will be copied
   * @param startLength the number of characters to extract
   * @param target the target buffer for extraction
   * @param codepage the desired codepage for the characters.  0 has
   * the special meaning of the default codepage
   * If `codepage` is an empty string (`""`),
   * then a simple conversion is performed on the codepage-invariant
   * subset ("invariant characters") of the platform encoding. See utypes.h.
   * If `target` is nullptr, then the number of bytes required for
   * `target` is returned. It is assumed that the target is big enough
   * to fit all of the characters.
   * @return the output string length, not including the terminating NUL
   * @stable ICU 2.0
   */
  inline int32_t extract(int32_t start,
                         int32_t startLength,
                         char* target,
                         const char* codepage = nullptr) const;

  /**
   * Copy the characters in the range
   * [`start`, `start + length`) into an array of characters
   * in a specified codepage.
   * This function does not write any more than `targetLength`
   * characters but returns the length of the entire output string
   * so that one can allocate a larger buffer and call the function again
   * if necessary.
   * The output string is NUL-terminated if possible.
   *
   * Recommendation: For invariant-character strings use
   * extract(int32_t start, int32_t length, char *target, int32_t targetCapacity, enum EInvariant inv) const
   * because it avoids object code dependencies of UnicodeString on
   * the conversion code.
   *
   * @param start offset of first character which will be copied
   * @param startLength the number of characters to extract
   * @param target the target buffer for extraction
   * @param targetLength the length of the target buffer
   * @param codepage the desired codepage for the characters.  0 has
   * the special meaning of the default codepage
   * If `codepage` is an empty string (`""`),
   * then a simple conversion is performed on the codepage-invariant
   * subset ("invariant characters") of the platform encoding. See utypes.h.
   * If `target` is nullptr, then the number of bytes required for
   * `target` is returned.
   * @return the output string length, not including the terminating NUL
   * @stable ICU 2.0
   */
  int32_t extract(int32_t start,
           int32_t startLength,
           char *target,
           uint32_t targetLength,
           const char *codepage) const;

  /**
   * Convert the UnicodeString into a codepage string using an existing UConverter.
   * The output string is NUL-terminated if possible.
   *
   * This function avoids the overhead of opening and closing a converter if
   * multiple strings are extracted.
   *
   * @param dest destination string buffer, can be nullptr if destCapacity==0
   * @param destCapacity the number of chars available at dest
   * @param cnv the converter object to be used (ucnv_resetFromUnicode() will be called),
   *        or nullptr for the default converter
   * @param errorCode normal ICU error code
   * @return the length of the output string, not counting the terminating NUL;
   *         if the length is greater than destCapacity, then the string will not fit
   *         and a buffer of the indicated length would need to be passed in
   * @stable ICU 2.0
   */
  int32_t extract(char *dest, int32_t destCapacity,
                  UConverter *cnv,
                  UErrorCode &errorCode) const;

#endif

  /**
   * Create a temporary substring for the specified range.
   * Unlike the substring constructor and setTo() functions,
   * the object returned here will be a read-only alias (using getBuffer())
   * rather than copying the text.
   * As a result, this substring operation is much faster but requires
   * that the original string not be modified or deleted during the lifetime
   * of the returned substring object.
   * @param start offset of the first character visible in the substring
   * @param length length of the substring
   * @return a read-only alias UnicodeString object for the substring
   * @stable ICU 4.4
   */
  UnicodeString tempSubString(int32_t start=0, int32_t length=INT32_MAX) const;

  /**
   * Create a temporary substring for the specified range.
   * Same as tempSubString(start, length) except that the substring range
   * is specified as a (start, limit) pair (with an exclusive limit index)
   * rather than a (start, length) pair.
   * @param start offset of the first character visible in the substring
   * @param limit offset immediately following the last character visible in the substring
   * @return a read-only alias UnicodeString object for the substring
   * @stable ICU 4.4
   */
  inline UnicodeString tempSubStringBetween(int32_t start, int32_t limit=INT32_MAX) const;

  /**
   * Convert the UnicodeString to UTF-8 and write the result
   * to a ByteSink. This is called by toUTF8String().
   * Unpaired surrogates are replaced with U+FFFD.
   * Calls u_strToUTF8WithSub().
   *
   * @param sink A ByteSink to which the UTF-8 version of the string is written.
   *             sink.Flush() is called at the end.
   * @stable ICU 4.2
   * @see toUTF8String
   */
  void toUTF8(ByteSink &sink) const;

  /**
   * Convert the UnicodeString to UTF-8 and append the result
   * to a standard string.
   * Unpaired surrogates are replaced with U+FFFD.
   * Calls toUTF8().
   *
   * @tparam StringClass A std::string or a std::u8string (or a compatible type)
   * @param result A std::string or a std::u8string (or a compatible object)
   *        to which the UTF-8 version of the string is appended.
   * @return The string object.
   * @stable ICU 4.2
   * @see toUTF8
   */
  template<typename StringClass>
  StringClass &toUTF8String(StringClass &result) const {
    StringByteSink<StringClass> sbs(&result, length());
    toUTF8(sbs);
    return result;
  }

#ifndef U_HIDE_DRAFT_API
  /**
   * Convert the UnicodeString to a UTF-8 string.
   * Unpaired surrogates are replaced with U+FFFD.
   * Calls toUTF8().
   *
   * @tparam StringClass A std::string or a std::u8string (or a compatible type)
   * @return A std::string or a std::u8string (or a compatible object)
   *        with the UTF-8 version of the string.
   * @draft ICU 78
   * @see toUTF8
   */
  template<typename StringClass>
  StringClass toUTF8String() const {
    StringClass result;
    StringByteSink<StringClass> sbs(&result, length());
    toUTF8(sbs);
    return result;
  }
#endif  // U_HIDE_DRAFT_API

  /**
   * Convert the UnicodeString to UTF-32.
   * Unpaired surrogates are replaced with U+FFFD.
   * Calls u_strToUTF32WithSub().
   *
   * @param utf32 destination string buffer, can be nullptr if capacity==0
   * @param capacity the number of UChar32s available at utf32
   * @param errorCode Standard ICU error code. Its input value must
   *                  pass the U_SUCCESS() test, or else the function returns
   *                  immediately. Check for U_FAILURE() on output or use with
   *                  function chaining. (See User Guide for details.)
   * @return The length of the UTF-32 string.
   * @see fromUTF32
   * @stable ICU 4.2
   */
  int32_t toUTF32(UChar32 *utf32, int32_t capacity, UErrorCode &errorCode) const;

  /* Length operations */

  /**
   * Return the length of the UnicodeString object.
   * The length is the number of char16_t code units are in the UnicodeString.
   * If you want the number of code points, please use countChar32().
   * @return the length of the UnicodeString object
   * @see countChar32
   * @stable ICU 2.0
   */
  inline int32_t length() const;

  /**
   * Count Unicode code points in the length char16_t code units of the string.
   * A code point may occupy either one or two char16_t code units.
   * Counting code points involves reading all code units.
   *
   * This functions is basically the inverse of moveIndex32().
   *
   * @param start the index of the first code unit to check
   * @param length the number of char16_t code units to check
   * @return the number of code points in the specified code units
   * @see length
   * @stable ICU 2.0
   */
  int32_t
  countChar32(int32_t start=0, int32_t length=INT32_MAX) const;

  /**
   * Check if the length char16_t code units of the string
   * contain more Unicode code points than a certain number.
   * This is more efficient than counting all code points in this part of the string
   * and comparing that number with a threshold.
   * This function may not need to scan the string at all if the length
   * falls within a certain range, and
   * never needs to count more than 'number+1' code points.
   * Logically equivalent to (countChar32(start, length)>number).
   * A Unicode code point may occupy either one or two char16_t code units.
   *
   * @param start the index of the first code unit to check (0 for the entire string)
   * @param length the number of char16_t code units to check
   *               (use INT32_MAX for the entire string; remember that start/length
   *                values are pinned)
   * @param number The number of code points in the (sub)string is compared against
   *               the 'number' parameter.
   * @return Boolean value for whether the string contains more Unicode code points
   *         than 'number'. Same as (u_countChar32(s, length)>number).
   * @see countChar32
   * @see u_strHasMoreChar32Than
   * @stable ICU 2.4
   */
  UBool
  hasMoreChar32Than(int32_t start, int32_t length, int32_t number) const;

  /**
   * Determine if this string is empty.
   * @return true if this string contains 0 characters, false otherwise.
   * @stable ICU 2.0
   */
  inline UBool isEmpty() const;

  /**
   * Return the capacity of the internal buffer of the UnicodeString object.
   * This is useful together with the getBuffer functions.
   * See there for details.
   *
   * @return the number of char16_ts available in the internal buffer
   * @see getBuffer
   * @stable ICU 2.0
   */
  inline int32_t getCapacity() const;

  /* Other operations */

  /**
   * Generate a hash code for this object.
   * @return The hash code of this UnicodeString.
   * @stable ICU 2.0
   */
  inline int32_t hashCode() const;

  /**
   * Determine if this object contains a valid string.
   * A bogus string has no value. It is different from an empty string,
   * although in both cases isEmpty() returns true and length() returns 0.
   * setToBogus() and isBogus() can be used to indicate that no string value is available.
   * For a bogus string, getBuffer() and getTerminatedBuffer() return nullptr, and
   * length() returns 0.
   *
   * @return true if the string is bogus/invalid, false otherwise
   * @see setToBogus()
   * @stable ICU 2.0
   */
  inline UBool isBogus() const;

#ifndef U_HIDE_DRAFT_API
private:
  // These type aliases are private; there is no guarantee that they will remain
  // aliases to the same types in subsequent versions of ICU.
  // Note that whether `std::u16string_view::const_iterator` is a pointer or a
  // class that models contiguous_iterator is platform-dependent.
  using unspecified_iterator = std::u16string_view::const_iterator;
  using unspecified_reverse_iterator = std::u16string_view::const_reverse_iterator;

public:
  /**
   * @return an iterator to the first code unit in this string.
   *     The iterator may be a pointer or a contiguous-iterator object.
   * @draft ICU 78
   */
  unspecified_iterator begin() const { return std::u16string_view(*this).begin(); }
  /**
   * @return an iterator to just past the last code unit in this string.
   *     The iterator may be a pointer or a contiguous-iterator object.
   * @draft ICU 78
   */
  unspecified_iterator end() const { return std::u16string_view(*this).end(); }
  /**
   * @return a reverse iterator to the last code unit in this string.
   *     The iterator may be a pointer or a contiguous-iterator object.
   * @draft ICU 78
   */
  unspecified_reverse_iterator rbegin() const { return std::u16string_view(*this).rbegin(); }
  /**
   * @return a reverse iterator to just before the first code unit in this string.
   *     The iterator may be a pointer or a contiguous-iterator object.
   * @draft ICU 78
   */
  unspecified_reverse_iterator rend() const { return std::u16string_view(*this).rend(); }
#endif  // U_HIDE_DRAFT_API

  //========================================
  // Write operations
  //========================================

  /* Assignment operations */

  /**
   * Assignment operator.  Replace the characters in this UnicodeString
   * with the characters from `srcText`.
   *
   * Starting with ICU 2.4, the assignment operator and the copy constructor
   * allocate a new buffer and copy the buffer contents even for readonly aliases.
   * By contrast, the fastCopyFrom() function implements the old,
   * more efficient but less safe behavior
   * of making this string also a readonly alias to the same buffer.
   *
   * If the source object has an "open" buffer from getBuffer(minCapacity),
   * then the copy is an empty string.
   *
   * @param srcText The text containing the characters to replace
   * @return a reference to this
   * @stable ICU 2.0
   * @see fastCopyFrom
   */
  UnicodeString &operator=(const UnicodeString &srcText);

  /**
   * Almost the same as the assignment operator.
   * Replace the characters in this UnicodeString
   * with the characters from `srcText`.
   *
   * This function works the same as the assignment operator
   * for all strings except for ones that are readonly aliases.
   *
   * Starting with ICU 2.4, the assignment operator and the copy constructor
   * allocate a new buffer and copy the buffer contents even for readonly aliases.
   * This function implements the old, more efficient but less safe behavior
   * of making this string also a readonly alias to the same buffer.
   *
   * The fastCopyFrom function must be used only if it is known that the lifetime of
   * this UnicodeString does not exceed the lifetime of the aliased buffer
   * including its contents, for example for strings from resource bundles
   * or aliases to string constants.
   *
   * If the source object has an "open" buffer from getBuffer(minCapacity),
   * then the copy is an empty string.
   *
   * @param src The text containing the characters to replace.
   * @return a reference to this
   * @stable ICU 2.4
   */
  UnicodeString &fastCopyFrom(const UnicodeString &src);

  /**
   * Assignment operator. Replaces the characters in this UnicodeString
   * with a copy of the characters from the `src`
   * which is, or which is implicitly convertible to,
   * a std::u16string_view or (if U_SIZEOF_WCHAR_T==2) std::wstring_view.
   *
   * @param src The string view containing the characters to copy.
   * @return a reference to this
   * @stable ICU 76
   */
  template<typename S, typename = std::enable_if_t<ConvertibleToU16StringView<S>>>
  inline UnicodeString &operator=(const S &src) {
    unBogus();
    return doReplace(0, length(), internal::toU16StringView(src));
  }

  /**
   * Move assignment operator; might leave src in bogus state.
   * This string will have the same contents and state that the source string had.
   * The behavior is undefined if *this and src are the same object.
   * @param src source string
   * @return *this
   * @stable ICU 56
   */
  UnicodeString &operator=(UnicodeString &&src) noexcept;

  /**
   * Swap strings.
   * @param other other string
   * @stable ICU 56
   */
  void swap(UnicodeString &other) noexcept;

  /**
   * Non-member UnicodeString swap function.
   * @param s1 will get s2's contents and state
   * @param s2 will get s1's contents and state
   * @stable ICU 56
   */
  friend inline void U_EXPORT2
  swap(UnicodeString &s1, UnicodeString &s2) noexcept {
    s1.swap(s2);
  }

  /**
   * Assignment operator.  Replace the characters in this UnicodeString
   * with the code unit `ch`.
   * @param ch the code unit to replace
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& operator= (char16_t ch);

  /**
   * Assignment operator.  Replace the characters in this UnicodeString
   * with the code point `ch`.
   * @param ch the code point to replace
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& operator= (UChar32 ch);

  /**
   * Set the text in the UnicodeString object to the characters
   * in `srcText` in the range
   * [`srcStart`, `srcText.length()`).
   * `srcText` is not modified.
   * @param srcText the source for the new characters
   * @param srcStart the offset into `srcText` where new characters
   * will be obtained
   * @return a reference to this
   * @stable ICU 2.2
   */
  inline UnicodeString& setTo(const UnicodeString& srcText,
               int32_t srcStart);

  /**
   * Set the text in the UnicodeString object to the characters
   * in `srcText` in the range
   * [`srcStart`, `srcStart + srcLength`).
   * `srcText` is not modified.
   * @param srcText the source for the new characters
   * @param srcStart the offset into `srcText` where new characters
   * will be obtained
   * @param srcLength the number of characters in `srcText` in the
   * replace string.
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& setTo(const UnicodeString& srcText,
               int32_t srcStart,
               int32_t srcLength);

  /**
   * Set the text in the UnicodeString object to the characters in
   * `srcText`.
   * `srcText` is not modified.
   * @param srcText the source for the new characters
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& setTo(const UnicodeString& srcText);

  /**
   * Set the characters in the UnicodeString object to the characters
   * in `srcChars`. `srcChars` is not modified.
   * @param srcChars the source for the new characters
   * @param srcLength the number of Unicode characters in srcChars.
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& setTo(const char16_t *srcChars,
               int32_t srcLength);

  /**
   * Set the characters in the UnicodeString object to the code unit
   * `srcChar`.
   * @param srcChar the code unit which becomes the UnicodeString's character
   * content
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& setTo(char16_t srcChar);

  /**
   * Set the characters in the UnicodeString object to the code point
   * `srcChar`.
   * @param srcChar the code point which becomes the UnicodeString's character
   * content
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& setTo(UChar32 srcChar);

  /**
   * Aliasing setTo() function, analogous to the readonly-aliasing char16_t* constructor.
   * The text will be used for the UnicodeString object, but
   * it will not be released when the UnicodeString is destroyed.
   * This has copy-on-write semantics:
   * When the string is modified, then the buffer is first copied into
   * newly allocated memory.
   * The aliased buffer is never modified.
   *
   * In an assignment to another UnicodeString, when using the copy constructor
   * or the assignment operator, the text will be copied.
   * When using fastCopyFrom(), the text will be aliased again,
   * so that both strings then alias the same readonly-text.
   *
   * @param isTerminated specifies if `text` is `NUL`-terminated.
   *                     This must be true if `textLength==-1`.
   * @param text The characters to alias for the UnicodeString.
   * @param textLength The number of Unicode characters in `text` to alias.
   *                   If -1, then this constructor will determine the length
   *                   by calling `u_strlen()`.
   * @return a reference to this
   * @stable ICU 2.0
   */
  UnicodeString &setTo(UBool isTerminated,
                       ConstChar16Ptr text,
                       int32_t textLength);

  /**
   * Aliasing setTo() function, analogous to the writable-aliasing char16_t* constructor.
   * The text will be used for the UnicodeString object, but
   * it will not be released when the UnicodeString is destroyed.
   * This has write-through semantics:
   * For as long as the capacity of the buffer is sufficient, write operations
   * will directly affect the buffer. When more capacity is necessary, then
   * a new buffer will be allocated and the contents copied as with regularly
   * constructed strings.
   * In an assignment to another UnicodeString, the buffer will be copied.
   * The extract(Char16Ptr dst) function detects whether the dst pointer is the same
   * as the string buffer itself and will in this case not copy the contents.
   *
   * @param buffer The characters to alias for the UnicodeString.
   * @param buffLength The number of Unicode characters in `buffer` to alias.
   * @param buffCapacity The size of `buffer` in char16_ts.
   * @return a reference to this
   * @stable ICU 2.0
   */
  UnicodeString &setTo(char16_t *buffer,
                       int32_t buffLength,
                       int32_t buffCapacity);

  /**
   * Make this UnicodeString object invalid.
   * The string will test true with isBogus().
   *
   * A bogus string has no value. It is different from an empty string.
   * It can be used to indicate that no string value is available.
   * getBuffer() and getTerminatedBuffer() return nullptr, and
   * length() returns 0.
   *
   * This utility function is used throughout the UnicodeString
   * implementation to indicate that a UnicodeString operation failed,
   * and may be used in other functions,
   * especially but not exclusively when such functions do not
   * take a UErrorCode for simplicity.
   *
   * The following methods, and no others, will clear a string object's bogus flag:
   * - remove()
   * - remove(0, INT32_MAX)
   * - truncate(0)
   * - operator=() (assignment operator)
   * - setTo(...)
   *
   * The simplest ways to turn a bogus string into an empty one
   * is to use the remove() function.
   * Examples for other functions that are equivalent to "set to empty string":
   * \code
   * if(s.isBogus()) {
   *   s.remove();           // set to an empty string (remove all), or
   *   s.remove(0, INT32_MAX); // set to an empty string (remove all), or
   *   s.truncate(0);        // set to an empty string (complete truncation), or
   *   s=UnicodeString();    // assign an empty string, or
   *   s.setTo((UChar32)-1); // set to a pseudo code point that is out of range, or
   *   s.setTo(u"", 0);      // set to an empty C Unicode string
   * }
   * \endcode
   *
   * @see isBogus()
   * @stable ICU 2.0
   */
  void setToBogus();

  /**
   * Set the character at the specified offset to the specified character.
   * @param offset A valid offset into the text of the character to set
   * @param ch The new character
   * @return A reference to this
   * @stable ICU 2.0
   */
  UnicodeString& setCharAt(int32_t offset,
               char16_t ch);


  /* Append operations */

  /**
   * Append operator. Append the code unit `ch` to the UnicodeString
   * object.
   * @param ch the code unit to be appended
   * @return a reference to this
   * @stable ICU 2.0
   */
 inline  UnicodeString& operator+= (char16_t ch);

  /**
   * Append operator. Append the code point `ch` to the UnicodeString
   * object.
   * @param ch the code point to be appended
   * @return a reference to this
   * @stable ICU 2.0
   */
 inline  UnicodeString& operator+= (UChar32 ch);

  /**
   * Append operator. Append the characters in `srcText` to the
   * UnicodeString object. `srcText` is not modified.
   * @param srcText the source for the new characters
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& operator+= (const UnicodeString& srcText);

  /**
   * Append operator. Appends the characters in `src`
   * which is, or which is implicitly convertible to,
   * a std::u16string_view or (if U_SIZEOF_WCHAR_T==2) std::wstring_view,
   * to the UnicodeString object.
   *
   * @param src the source for the new characters
   * @return a reference to this
   * @stable ICU 76
   */
  template<typename S, typename = std::enable_if_t<ConvertibleToU16StringView<S>>>
  inline UnicodeString& operator+=(const S &src) {
    return doAppend(internal::toU16StringView(src));
  }

  /**
   * Append the characters
   * in `srcText` in the range
   * [`srcStart`, `srcStart + srcLength`) to the
   * UnicodeString object at offset `start`. `srcText`
   * is not modified.
   * @param srcText the source for the new characters
   * @param srcStart the offset into `srcText` where new characters
   * will be obtained
   * @param srcLength the number of characters in `srcText` in
   * the append string
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& append(const UnicodeString& srcText,
            int32_t srcStart,
            int32_t srcLength);

  /**
   * Append the characters in `srcText` to the UnicodeString object.
   * `srcText` is not modified.
   * @param srcText the source for the new characters
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& append(const UnicodeString& srcText);

  /**
   * Append the characters in `srcChars` in the range
   * [`srcStart`, `srcStart + srcLength`) to the UnicodeString
   * object at offset
   * `start`. `srcChars` is not modified.
   * @param srcChars the source for the new characters
   * @param srcStart the offset into `srcChars` where new characters
   * will be obtained
   * @param srcLength the number of characters in `srcChars` in
   *                  the append string; can be -1 if `srcChars` is NUL-terminated
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& append(const char16_t *srcChars,
            int32_t srcStart,
            int32_t srcLength);

  /**
   * Append the characters in `srcChars` to the UnicodeString object.
   * `srcChars` is not modified.
   * @param srcChars the source for the new characters
   * @param srcLength the number of Unicode characters in `srcChars`;
   *                  can be -1 if `srcChars` is NUL-terminated
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& append(ConstChar16Ptr srcChars,
            int32_t srcLength);

  /**
   * Appends the characters in `src`
   * which is, or which is implicitly convertible to,
   * a std::u16string_view or (if U_SIZEOF_WCHAR_T==2) std::wstring_view,
   * to the UnicodeString object.
   *
   * @param src the source for the new characters
   * @return a reference to this
   * @stable ICU 76
   */
  template<typename S, typename = std::enable_if_t<ConvertibleToU16StringView<S>>>
  inline UnicodeString& append(const S &src) {
    return doAppend(internal::toU16StringView(src));
  }

  /**
   * Append the code unit `srcChar` to the UnicodeString object.
   * @param srcChar the code unit to append
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& append(char16_t srcChar);

  /**
   * Append the code point `srcChar` to the UnicodeString object.
   * @param srcChar the code point to append
   * @return a reference to this
   * @stable ICU 2.0
   */
  UnicodeString& append(UChar32 srcChar);

#ifndef U_HIDE_DRAFT_API
  /**
   * Appends the code unit `c` to the UnicodeString object.
   * Same as append(c) except does not return *this.
   *
   * @param c the code unit to append
   * @draft ICU 78
   */
  inline void push_back(char16_t c) { append(c); }
#endif  // U_HIDE_DRAFT_API

  /* Insert operations */

  /**
   * Insert the characters in `srcText` in the range
   * [`srcStart`, `srcStart + srcLength`) into the UnicodeString
   * object at offset `start`. `srcText` is not modified.
   * @param start the offset where the insertion begins
   * @param srcText the source for the new characters
   * @param srcStart the offset into `srcText` where new characters
   * will be obtained
   * @param srcLength the number of characters in `srcText` in
   * the insert string
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& insert(int32_t start,
            const UnicodeString& srcText,
            int32_t srcStart,
            int32_t srcLength);

  /**
   * Insert the characters in `srcText` into the UnicodeString object
   * at offset `start`. `srcText` is not modified.
   * @param start the offset where the insertion begins
   * @param srcText the source for the new characters
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& insert(int32_t start,
            const UnicodeString& srcText);

  /**
   * Insert the characters in `srcChars` in the range
   * [`srcStart`, `srcStart + srcLength`) into the UnicodeString
   *  object at offset `start`. `srcChars` is not modified.
   * @param start the offset at which the insertion begins
   * @param srcChars the source for the new characters
   * @param srcStart the offset into `srcChars` where new characters
   * will be obtained
   * @param srcLength the number of characters in `srcChars`
   * in the insert string
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& insert(int32_t start,
            const char16_t *srcChars,
            int32_t srcStart,
            int32_t srcLength);

  /**
   * Insert the characters in `srcChars` into the UnicodeString object
   * at offset `start`. `srcChars` is not modified.
   * @param start the offset where the insertion begins
   * @param srcChars the source for the new characters
   * @param srcLength the number of Unicode characters in srcChars.
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& insert(int32_t start,
            ConstChar16Ptr srcChars,
            int32_t srcLength);

  /**
   * Insert the code unit `srcChar` into the UnicodeString object at
   * offset `start`.
   * @param start the offset at which the insertion occurs
   * @param srcChar the code unit to insert
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& insert(int32_t start,
            char16_t srcChar);

  /**
   * Insert the code point `srcChar` into the UnicodeString object at
   * offset `start`.
   * @param start the offset at which the insertion occurs
   * @param srcChar the code point to insert
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& insert(int32_t start,
            UChar32 srcChar);


  /* Replace operations */

  /**
   * Replace the characters in the range
   * [`start`, `start + length`) with the characters in
   * `srcText` in the range
   * [`srcStart`, `srcStart + srcLength`).
   * `srcText` is not modified.
   * @param start the offset at which the replace operation begins
   * @param length the number of characters to replace. The character at
   * `start + length` is not modified.
   * @param srcText the source for the new characters
   * @param srcStart the offset into `srcText` where new characters
   * will be obtained
   * @param srcLength the number of characters in `srcText` in
   * the replace string
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& replace(int32_t start,
             int32_t length,
             const UnicodeString& srcText,
             int32_t srcStart,
             int32_t srcLength);

  /**
   * Replace the characters in the range
   * [`start`, `start + length`)
   * with the characters in `srcText`.  `srcText` is
   *  not modified.
   * @param start the offset at which the replace operation begins
   * @param length the number of characters to replace. The character at
   * `start + length` is not modified.
   * @param srcText the source for the new characters
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& replace(int32_t start,
             int32_t length,
             const UnicodeString& srcText);

  /**
   * Replace the characters in the range
   * [`start`, `start + length`) with the characters in
   * `srcChars` in the range
   * [`srcStart`, `srcStart + srcLength`). `srcChars`
   * is not modified.
   * @param start the offset at which the replace operation begins
   * @param length the number of characters to replace.  The character at
   * `start + length` is not modified.
   * @param srcChars the source for the new characters
   * @param srcStart the offset into `srcChars` where new characters
   * will be obtained
   * @param srcLength the number of characters in `srcChars`
   * in the replace string
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& replace(int32_t start,
             int32_t length,
             const char16_t *srcChars,
             int32_t srcStart,
             int32_t srcLength);

  /**
   * Replace the characters in the range
   * [`start`, `start + length`) with the characters in
   * `srcChars`.  `srcChars` is not modified.
   * @param start the offset at which the replace operation begins
   * @param length number of characters to replace.  The character at
   * `start + length` is not modified.
   * @param srcChars the source for the new characters
   * @param srcLength the number of Unicode characters in srcChars
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& replace(int32_t start,
             int32_t length,
             ConstChar16Ptr srcChars,
             int32_t srcLength);

  /**
   * Replace the characters in the range
   * [`start`, `start + length`) with the code unit
   * `srcChar`.
   * @param start the offset at which the replace operation begins
   * @param length the number of characters to replace.  The character at
   * `start + length` is not modified.
   * @param srcChar the new code unit
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& replace(int32_t start,
             int32_t length,
             char16_t srcChar);

  /**
   * Replace the characters in the range
   * [`start`, `start + length`) with the code point
   * `srcChar`.
   * @param start the offset at which the replace operation begins
   * @param length the number of characters to replace.  The character at
   * `start + length` is not modified.
   * @param srcChar the new code point
   * @return a reference to this
   * @stable ICU 2.0
   */
  UnicodeString& replace(int32_t start, int32_t length, UChar32 srcChar);

  /**
   * Replace the characters in the range [`start`, `limit`)
   * with the characters in `srcText`. `srcText` is not modified.
   * @param start the offset at which the replace operation begins
   * @param limit the offset immediately following the replace range
   * @param srcText the source for the new characters
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& replaceBetween(int32_t start,
                int32_t limit,
                const UnicodeString& srcText);

  /**
   * Replace the characters in the range [`start`, `limit`)
   * with the characters in `srcText` in the range
   * [`srcStart`, `srcLimit`). `srcText` is not modified.
   * @param start the offset at which the replace operation begins
   * @param limit the offset immediately following the replace range
   * @param srcText the source for the new characters
   * @param srcStart the offset into `srcChars` where new characters
   * will be obtained
   * @param srcLimit the offset immediately following the range to copy
   * in `srcText`
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& replaceBetween(int32_t start,
                int32_t limit,
                const UnicodeString& srcText,
                int32_t srcStart,
                int32_t srcLimit);

  /**
   * Replace a substring of this object with the given text.
   * @param start the beginning index, inclusive; `0 <= start <= limit`.
   * @param limit the ending index, exclusive; `start <= limit <= length()`.
   * @param text the text to replace characters `start` to `limit - 1`
   * @stable ICU 2.0
   */
  virtual void handleReplaceBetween(int32_t start,
                                    int32_t limit,
                                    const UnicodeString& text) override;

  /**
   * Replaceable API
   * @return true if it has MetaData
   * @stable ICU 2.4
   */
  virtual UBool hasMetaData() const override;

  /**
   * Copy a substring of this object, retaining attribute (out-of-band)
   * information.  This method is used to duplicate or reorder substrings.
   * The destination index must not overlap the source range.
   *
   * @param start the beginning index, inclusive; `0 <= start <= limit`.
   * @param limit the ending index, exclusive; `start <= limit <= length()`.
   * @param dest the destination index.  The characters from
   *             `start..limit-1` will be copied to `dest`.
   * Implementations of this method may assume that `dest <= start ||
   * dest >= limit`.
   * @stable ICU 2.0
   */
  virtual void copy(int32_t start, int32_t limit, int32_t dest) override;

  /* Search and replace operations */

  /**
   * Replace all occurrences of characters in oldText with the characters
   * in newText
   * @param oldText the text containing the search text
   * @param newText the text containing the replacement text
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& findAndReplace(const UnicodeString& oldText,
                const UnicodeString& newText);

  /**
   * Replace all occurrences of characters in oldText with characters
   * in newText
   * in the range [`start`, `start + length`).
   * @param start the start of the range in which replace will performed
   * @param length the length of the range in which replace will be performed
   * @param oldText the text containing the search text
   * @param newText the text containing the replacement text
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& findAndReplace(int32_t start,
                int32_t length,
                const UnicodeString& oldText,
                const UnicodeString& newText);

  /**
   * Replace all occurrences of characters in oldText in the range
   * [`oldStart`, `oldStart + oldLength`) with the characters
   * in newText in the range
   * [`newStart`, `newStart + newLength`)
   * in the range [`start`, `start + length`).
   * @param start the start of the range in which replace will performed
   * @param length the length of the range in which replace will be performed
   * @param oldText the text containing the search text
   * @param oldStart the start of the search range in `oldText`
   * @param oldLength the length of the search range in `oldText`
   * @param newText the text containing the replacement text
   * @param newStart the start of the replacement range in `newText`
   * @param newLength the length of the replacement range in `newText`
   * @return a reference to this
   * @stable ICU 2.0
   */
  UnicodeString& findAndReplace(int32_t start,
                int32_t length,
                const UnicodeString& oldText,
                int32_t oldStart,
                int32_t oldLength,
                const UnicodeString& newText,
                int32_t newStart,
                int32_t newLength);


  /* Remove operations */

  /**
   * Removes all characters from the UnicodeString object and clears the bogus flag.
   * This is the UnicodeString equivalent of std::string’s clear().
   *
   * @return a reference to this
   * @see setToBogus
   * @stable ICU 2.0
   */
  inline UnicodeString& remove();

  /**
   * Remove the characters in the range
   * [`start`, `start + length`) from the UnicodeString object.
   * @param start the offset of the first character to remove
   * @param length the number of characters to remove
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& remove(int32_t start,
                               int32_t length = static_cast<int32_t>(INT32_MAX));

  /**
   * Remove the characters in the range
   * [`start`, `limit`) from the UnicodeString object.
   * @param start the offset of the first character to remove
   * @param limit the offset immediately following the range to remove
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& removeBetween(int32_t start,
                                      int32_t limit = static_cast<int32_t>(INT32_MAX));

  /**
   * Retain only the characters in the range
   * [`start`, `limit`) from the UnicodeString object.
   * Removes characters before `start` and at and after `limit`.
   * @param start the offset of the first character to retain
   * @param limit the offset immediately following the range to retain
   * @return a reference to this
   * @stable ICU 4.4
   */
  inline UnicodeString &retainBetween(int32_t start, int32_t limit = INT32_MAX);

  /* Length operations */

  /**
   * Pad the start of this UnicodeString with the character `padChar`.
   * If the length of this UnicodeString is less than targetLength,
   * length() - targetLength copies of padChar will be added to the
   * beginning of this UnicodeString.
   * @param targetLength the desired length of the string
   * @param padChar the character to use for padding. Defaults to
   * space (U+0020)
   * @return true if the text was padded, false otherwise.
   * @stable ICU 2.0
   */
  UBool padLeading(int32_t targetLength,
                    char16_t padChar = 0x0020);

  /**
   * Pad the end of this UnicodeString with the character `padChar`.
   * If the length of this UnicodeString is less than targetLength,
   * length() - targetLength copies of padChar will be added to the
   * end of this UnicodeString.
   * @param targetLength the desired length of the string
   * @param padChar the character to use for padding. Defaults to
   * space (U+0020)
   * @return true if the text was padded, false otherwise.
   * @stable ICU 2.0
   */
  UBool padTrailing(int32_t targetLength,
                     char16_t padChar = 0x0020);

  /**
   * Truncate this UnicodeString to the `targetLength`.
   * @param targetLength the desired length of this UnicodeString.
   * @return true if the text was truncated, false otherwise
   * @stable ICU 2.0
   */
  inline UBool truncate(int32_t targetLength);

  /**
   * Trims leading and trailing whitespace from this UnicodeString.
   * @return a reference to this
   * @stable ICU 2.0
   */
  UnicodeString& trim();

  /* Miscellaneous operations */

  /**
   * Reverse this UnicodeString in place.
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& reverse();

  /**
   * Reverse the range [`start`, `start + length`) in
   * this UnicodeString.
   * @param start the start of the range to reverse
   * @param length the number of characters to to reverse
   * @return a reference to this
   * @stable ICU 2.0
   */
  inline UnicodeString& reverse(int32_t start,
             int32_t length);

  /**
   * Convert the characters in this to UPPER CASE following the conventions of
   * the default locale.
   * @return A reference to this.
   * @stable ICU 2.0
   */
  UnicodeString& toUpper();

  /**
   * Convert the characters in this to UPPER CASE following the conventions of
   * a specific locale.
   * @param locale The locale containing the conventions to use.
   * @return A reference to this.
   * @stable ICU 2.0
   */
  UnicodeString& toUpper(const Locale& locale);

  /**
   * Convert the characters in this to lower case following the conventions of
   * the default locale.
   * @return A reference to this.
   * @stable ICU 2.0
   */
  UnicodeString& toLower();

  /**
   * Convert the characters in this to lower case following the conventions of
   * a specific locale.
   * @param locale The locale containing the conventions to use.
   * @return A reference to this.
   * @stable ICU 2.0
   */
  UnicodeString& toLower(const Locale& locale);

#if !UCONFIG_NO_BREAK_ITERATION

  /**
   * Titlecase this string, convenience function using the default locale.
   *
   * Casing is locale-dependent and context-sensitive.
   * Titlecasing uses a break iterator to find the first characters of words
   * that are to be titlecased. It titlecases those characters and lowercases
   * all others.
   *
   * The titlecase break iterator can be provided to customize for arbitrary
   * styles, using rules and dictionaries beyond the standard iterators.
   * It may be more efficient to always provide an iterator to avoid
   * opening and closing one for each string.
   * If the break iterator passed in is null, the default Unicode algorithm
   * will be used to determine the titlecase positions.
   *
   * This function uses only the setText(), first() and next() methods of the
   * provided break iterator.
   *
   * @param titleIter A break iterator to find the first characters of words
   *                  that are to be titlecased.
   *                  If none is provided (0), then a standard titlecase
   *                  break iterator is opened.
   *                  Otherwise the provided iterator is set to the string's text.
   * @return A reference to this.
   * @stable ICU 2.1
   */
  UnicodeString &toTitle(BreakIterator *titleIter);

  /**
   * Titlecase this string.
   *
   * Casing is locale-dependent and context-sensitive.
   * Titlecasing uses a break iterator to find the first characters of words
   * that are to be titlecased. It titlecases those characters and lowercases
   * all others.
   *
   * The titlecase break iterator can be provided to customize for arbitrary
   * styles, using rules and dictionaries beyond the standard iterators.
   * It may be more efficient to always provide an iterator to avoid
   * opening and closing one for each string.
   * If the break iterator passed in is null, the default Unicode algorithm
   * will be used to determine the titlecase positions.
   *
   * This function uses only the setText(), first() and next() methods of the
   * provided break iterator.
   *
   * @param titleIter A break iterator to find the first characters of words
   *                  that are to be titlecased.
   *                  If none is provided (0), then a standard titlecase
   *                  break iterator is opened.
   *                  Otherwise the provided iterator is set to the string's text.
   * @param locale    The locale to consider.
   * @return A reference to this.
   * @stable ICU 2.1
   */
  UnicodeString &toTitle(BreakIterator *titleIter, const Locale &locale);

  /**
   * Titlecase this string, with options.
   *
   * Casing is locale-dependent and context-sensitive.
   * Titlecasing uses a break iterator to find the first characters of words
   * that are to be titlecased. It titlecases those characters and lowercases
   * all others. (This can be modified with options.)
   *
   * The titlecase break iterator can be provided to customize for arbitrary
   * styles, using rules and dictionaries beyond the standard iterators.
   * It may be more efficient to always provide an iterator to avoid
   * opening and closing one for each string.
   * If the break iterator passed in is null, the default Unicode algorithm
   * will be used to determine the titlecase positions.
   *
   * This function uses only the setText(), first() and next() methods of the
   * provided break iterator.
   *
   * @param titleIter A break iterator to find the first characters of words
   *                  that are to be titlecased.
   *                  If none is provided (0), then a standard titlecase
   *                  break iterator is opened.
   *                  Otherwise the provided iterator is set to the string's text.
   * @param locale    The locale to consider.
   * @param options   Options bit set, usually 0. See U_TITLECASE_NO_LOWERCASE,
   *                  U_TITLECASE_NO_BREAK_ADJUSTMENT, U_TITLECASE_ADJUST_TO_CASED,
   *                  U_TITLECASE_WHOLE_STRING, U_TITLECASE_SENTENCES.
   * @return A reference to this.
   * @stable ICU 3.8
   */
  UnicodeString &toTitle(BreakIterator *titleIter, const Locale &locale, uint32_t options);

#endif

  /**
   * Case-folds the characters in this string.
   *
   * Case-folding is locale-independent and not context-sensitive,
   * but there is an option for whether to include or exclude mappings for dotted I
   * and dotless i that are marked with 'T' in CaseFolding.txt.
   *
   * The result may be longer or shorter than the original.
   *
   * @param options Either U_FOLD_CASE_DEFAULT or U_FOLD_CASE_EXCLUDE_SPECIAL_I
   * @return A reference to this.
   * @stable ICU 2.0
   */
  UnicodeString &foldCase(uint32_t options=0 /*U_FOLD_CASE_DEFAULT*/);

  //========================================
  // Access to the internal buffer
  //========================================

  /**
   * Get a read/write pointer to the internal buffer.
   * The buffer is guaranteed to be large enough for at least minCapacity char16_ts,
   * writable, and is still owned by the UnicodeString object.
   * Calls to getBuffer(minCapacity) must not be nested, and
   * must be matched with calls to releaseBuffer(newLength).
   * If the string buffer was read-only or shared,
   * then it will be reallocated and copied.
   *
   * An attempted nested call will return 0, and will not further modify the
   * state of the UnicodeString object.
   * It also returns 0 if the string is bogus.
   *
   * The actual capacity of the string buffer may be larger than minCapacity.
   * getCapacity() returns the actual capacity.
   * For many operations, the full capacity should be used to avoid reallocations.
   *
   * While the buffer is "open" between getBuffer(minCapacity)
   * and releaseBuffer(newLength), the following applies:
   * - The string length is set to 0.
   * - Any read API call on the UnicodeString object will behave like on a 0-length string.
   * - Any write API call on the UnicodeString object is disallowed and will have no effect.
   * - You can read from and write to the returned buffer.
   * - The previous string contents will still be in the buffer;
   *   if you want to use it, then you need to call length() before getBuffer(minCapacity).
   *   If the length() was greater than minCapacity, then any contents after minCapacity
   *   may be lost.
   *   The buffer contents is not NUL-terminated by getBuffer().
   *   If length() < getCapacity() then you can terminate it by writing a NUL
   *   at index length().
   * - You must call releaseBuffer(newLength) before and in order to
   *   return to normal UnicodeString operation.
   *
   * @param minCapacity the minimum number of char16_ts that are to be available
   *        in the buffer, starting at the returned pointer;
   *        default to the current string capacity if minCapacity==-1
   * @return a writable pointer to the internal string buffer,
   *         or nullptr if an error occurs (nested calls, out of memory)
   *
   * @see releaseBuffer
   * @see getTerminatedBuffer()
   * @stable ICU 2.0
   */
  char16_t *getBuffer(int32_t minCapacity);

  /**
   * Release a read/write buffer on a UnicodeString object with an
   * "open" getBuffer(minCapacity).
   * This function must be called in a matched pair with getBuffer(minCapacity).
   * releaseBuffer(newLength) must be called if and only if a getBuffer(minCapacity) is "open".
   *
   * It will set the string length to newLength, at most to the current capacity.
   * If newLength==-1 then it will set the length according to the
   * first NUL in the buffer, or to the capacity if there is no NUL.
   *
   * After calling releaseBuffer(newLength) the UnicodeString is back to normal operation.
   *
   * @param newLength the new length of the UnicodeString object;
   *        defaults to the current capacity if newLength is greater than that;
   *        if newLength==-1, it defaults to u_strlen(buffer) but not more than
   *        the current capacity of the string
   *
   * @see getBuffer(int32_t minCapacity)
   * @stable ICU 2.0
   */
  void releaseBuffer(int32_t newLength=-1);

  /**
   * Get a read-only pointer to the internal buffer.
   * This can be called at any time on a valid UnicodeString.
   *
   * It returns 0 if the string is bogus, or
   * during an "open" getBuffer(minCapacity).
   *
   * It can be called as many times as desired.
   * The pointer that it returns will remain valid until the UnicodeString object is modified,
   * at which time the pointer is semantically invalidated and must not be used any more.
   *
   * The capacity of the buffer can be determined with getCapacity().
   * The part after length() may or may not be initialized and valid,
   * depending on the history of the UnicodeString object.
   *
   * The buffer contents is (probably) not NUL-terminated.
   * You can check if it is with
   * `(s.length() < s.getCapacity() && buffer[s.length()]==0)`.
   * (See getTerminatedBuffer().)
   *
   * The buffer may reside in read-only memory. Its contents must not
   * be modified.
   *
   * @return a read-only pointer to the internal string buffer,
   *         or nullptr if the string is empty or bogus
   *
   * @see getBuffer(int32_t minCapacity)
   * @see getTerminatedBuffer()
   * @stable ICU 2.0
   */
  inline const char16_t *getBuffer() const;

  /**
   * Get a read-only pointer to the internal buffer,
   * making sure that it is NUL-terminated.
   * This can be called at any time on a valid UnicodeString.
   *
   * It returns 0 if the string is bogus, or
   * during an "open" getBuffer(minCapacity), or if the buffer cannot
   * be NUL-terminated (because memory allocation failed).
   *
   * It can be called as many times as desired.
   * The pointer that it returns will remain valid until the UnicodeString object is modified,
   * at which time the pointer is semantically invalidated and must not be used any more.
   *
   * The capacity of the buffer can be determined with getCapacity().
   * The part after length()+1 may or may not be initialized and valid,
   * depending on the history of the UnicodeString object.
   *
   * The buffer contents is guaranteed to be NUL-terminated.
   * getTerminatedBuffer() may reallocate the buffer if a terminating NUL
   * is written.
   * For this reason, this function is not const, unlike getBuffer().
   * Note that a UnicodeString may also contain NUL characters as part of its contents.
   *
   * The buffer may reside in read-only memory. Its contents must not
   * be modified.
   *
   * @return a read-only pointer to the internal string buffer,
   *         or 0 if the string is empty or bogus
   *
   * @see getBuffer(int32_t minCapacity)
   * @see getBuffer()
   * @stable ICU 2.2
   */
  const char16_t *getTerminatedBuffer();

  /**
   * Converts to a std::u16string_view.
   *
   * @return a string view of the contents of this string
   * @stable ICU 76
   */
  inline operator std::u16string_view() const {
    return {getBuffer(), static_cast<std::u16string_view::size_type>(length())};
  }

#if U_SIZEOF_WCHAR_T==2 || defined(U_IN_DOXYGEN)
  /**
   * Converts to a std::wstring_view.
   *
   * Note: This should remain draft until C++ standard plans
   * about char16_t vs. wchar_t become clearer.
   *
   * @return a string view of the contents of this string
   * @stable ICU 76
   */
  inline operator std::wstring_view() const {
    const char16_t *p = getBuffer();
#ifdef U_ALIASING_BARRIER
    U_ALIASING_BARRIER(p);
#endif
    return { reinterpret_cast<const wchar_t *>(p), (std::wstring_view::size_type)length() };
  }
#endif  // U_SIZEOF_WCHAR_T

  //========================================
  // Constructors
  //========================================

  /** Construct an empty UnicodeString.
   * @stable ICU 2.0
   */
  inline UnicodeString();

  /**
   * Construct a UnicodeString with capacity to hold `capacity` char16_ts
   * @param capacity the number of char16_ts this UnicodeString should hold
   * before a resize is necessary; if count is greater than 0 and count
   * code points c take up more space than capacity, then capacity is adjusted
   * accordingly.
   * @param c is used to initially fill the string
   * @param count specifies how many code points c are to be written in the
   *              string
   * @stable ICU 2.0
   */
  UnicodeString(int32_t capacity, UChar32 c, int32_t count);

  /**
   * Single char16_t (code unit) constructor.
   *
   * It is recommended to mark this constructor "explicit" by
   * `-DUNISTR_FROM_CHAR_EXPLICIT=explicit`
   * on the compiler command line or similar.
   * @param ch the character to place in the UnicodeString
   * @stable ICU 2.0
   */
  UNISTR_FROM_CHAR_EXPLICIT UnicodeString(char16_t ch);

  /**
   * Single UChar32 (code point) constructor.
   *
   * It is recommended to mark this constructor "explicit" by
   * `-DUNISTR_FROM_CHAR_EXPLICIT=explicit`
   * on the compiler command line or similar.
   * @param ch the character to place in the UnicodeString
   * @stable ICU 2.0
   */
  UNISTR_FROM_CHAR_EXPLICIT UnicodeString(UChar32 ch);

#ifdef U_HIDE_DRAFT_API
  /**
   * char16_t* constructor.
   *
   * It is recommended to mark this constructor "explicit" by
   * `-DUNISTR_FROM_STRING_EXPLICIT=explicit`
   * on the compiler command line or similar.
   *
   * Note, for string literals:
   * Since C++17 and ICU 76, you can use UTF-16 string literals with compile-time
   * length determination:
   * \code
   * UnicodeString str(u"literal");
   * if (str == u"other literal") { ... }
   * \endcode
   *
   * @param text The characters to place in the UnicodeString.  `text`
   * must be NUL (U+0000) terminated.
   * @stable ICU 2.0
   */
  UNISTR_FROM_STRING_EXPLICIT UnicodeString(const char16_t *text) :
      UnicodeString(text, -1) {}
#endif  // U_HIDE_DRAFT_API

#if !U_CHAR16_IS_TYPEDEF && \
    (defined(U_HIDE_DRAFT_API) || (defined(_LIBCPP_VERSION) && _LIBCPP_VERSION >= 180000))
  /**
   * uint16_t * constructor.
   * Delegates to UnicodeString(const char16_t *).
   *
   * It is recommended to mark this constructor "explicit" by
   * `-DUNISTR_FROM_STRING_EXPLICIT=explicit`
   * on the compiler command line or similar.
   *
   * Note, for string literals:
   * Since C++17 and ICU 76, you can use UTF-16 string literals with compile-time
   * length determination:
   * \code
   * UnicodeString str(u"literal");
   * if (str == u"other literal") { ... }
   * \endcode
   *
   * @param text NUL-terminated UTF-16 string
   * @stable ICU 59
   */
  UNISTR_FROM_STRING_EXPLICIT UnicodeString(const uint16_t *text) :
      UnicodeString(ConstChar16Ptr(text), -1) {}
#endif

#if defined(U_HIDE_DRAFT_API) && (U_SIZEOF_WCHAR_T==2 || defined(U_IN_DOXYGEN))
  /**
   * wchar_t * constructor.
   * (Only defined if U_SIZEOF_WCHAR_T==2.)
   * Delegates to UnicodeString(const char16_t *).
   *
   * It is recommended to mark this constructor "explicit" by
   * `-DUNISTR_FROM_STRING_EXPLICIT=explicit`
   * on the compiler command line or similar.
   *
   * Note, for string literals:
   * Since C++17 and ICU 76, you can use UTF-16 string literals with compile-time
   * length determination:
   * \code
   * UnicodeString str(u"literal");
   * if (str == u"other literal") { ... }
   * \endcode
   *
   * @param text NUL-terminated UTF-16 string
   * @stable ICU 59
   */
  UNISTR_FROM_STRING_EXPLICIT UnicodeString(const wchar_t *text) :
      UnicodeString(ConstChar16Ptr(text), -1) {}
#endif

  /**
   * nullptr_t constructor.
   * Effectively the same as the default constructor, makes an empty string object.
   *
   * It is recommended to mark this constructor "explicit" by
   * `-DUNISTR_FROM_STRING_EXPLICIT=explicit`
   * on the compiler command line or similar.
   * @param text nullptr
   * @stable ICU 59
   */
  UNISTR_FROM_STRING_EXPLICIT inline UnicodeString(const std::nullptr_t text);

  /**
   * char16_t* constructor.
   *
   * Note, for string literals:
   * Since C++17 and ICU 76, you can use UTF-16 string literals with compile-time
   * length determination:
   * \code
   * UnicodeString str(u"literal");
   * if (str == u"other literal") { ... }
   * \endcode
   *
   * @param text The characters to place in the UnicodeString.
   * @param textLength The number of Unicode characters in `text`
   * to copy.
   * @stable ICU 2.0
   */
  UnicodeString(const char16_t *text,
        int32_t textLength);

#if !U_CHAR16_IS_TYPEDEF
  /**
   * uint16_t * constructor.
   * Delegates to UnicodeString(const char16_t *, int32_t).
   *
   * Note, for string literals:
   * Since C++17 and ICU 76, you can use UTF-16 string literals with compile-time
   * length determination:
   * \code
   * UnicodeString str(u"literal");
   * if (str == u"other literal") { ... }
   * \endcode
   *
   * @param text UTF-16 string
   * @param textLength string length
   * @stable ICU 59
   */
  UnicodeString(const uint16_t *text, int32_t textLength) :
      UnicodeString(ConstChar16Ptr(text), textLength) {}
#endif

#if U_SIZEOF_WCHAR_T==2 || defined(U_IN_DOXYGEN)
  /**
   * wchar_t * constructor.
   * (Only defined if U_SIZEOF_WCHAR_T==2.)
   * Delegates to UnicodeString(const char16_t *, int32_t).
   *
   * Note, for string literals:
   * Since C++17 and ICU 76, you can use UTF-16 string literals with compile-time
   * length determination:
   * \code
   * UnicodeString str(u"literal");
   * if (str == u"other literal") { ... }
   * \endcode
   *
   * @param text UTF-16 string
   * @param textLength string length
   * @stable ICU 59
   */
  UnicodeString(const wchar_t *text, int32_t textLength) :
      UnicodeString(ConstChar16Ptr(text), textLength) {}
#endif

  /**
   * nullptr_t constructor.
   * Effectively the same as the default constructor, makes an empty string object.
   * @param text nullptr
   * @param textLength ignored
   * @stable ICU 59
   */
  inline UnicodeString(const std::nullptr_t text, int32_t textLength);

  /**
   * Constructor from `text`
   * which is, or which is implicitly convertible to,
   * a std::u16string_view or (if U_SIZEOF_WCHAR_T==2) std::wstring_view.
   * The string is bogus if the string view is too long.
   *
   * If you need a UnicodeString but need not copy the string view contents,
   * then you can call the UnicodeString::readOnlyAlias() function instead of this constructor.
   *
   * @param text UTF-16 string
   * @stable ICU 76
   */
  template<typename S, typename = std::enable_if_t<ConvertibleToU16StringView<S>>>
  UNISTR_FROM_STRING_EXPLICIT UnicodeString(const S &text) {
    fUnion.fFields.fLengthAndFlags = kShortString;
    doAppend(internal::toU16StringViewNullable(text));
  }

  /**
   * Readonly-aliasing char16_t* constructor.
   * The text will be used for the UnicodeString object, but
   * it will not be released when the UnicodeString is destroyed.
   * This has copy-on-write semantics:
   * When the string is modified, then the buffer is first copied into
   * newly allocated memory.
   * The aliased buffer is never modified.
   *
   * In an assignment to another UnicodeString, when using the copy constructor
   * or the assignment operator, the text will be copied.
   * When using fastCopyFrom(), the text will be aliased again,
   * so that both strings then alias the same readonly-text.
   *
   * Note, for string literals:
   * Since C++17 and ICU 76, you can use UTF-16 string literals with compile-time
   * length determination:
   * \code
   * UnicodeString alias = UnicodeString::readOnlyAlias(u"literal");
   * if (str == u"other literal") { ... }
   * \endcode
   *
   * @param isTerminated specifies if `text` is `NUL`-terminated.
   *                     This must be true if `textLength==-1`.
   * @param text The characters to alias for the UnicodeString.
   * @param textLength The number of Unicode characters in `text` to alias.
   *                   If -1, then this constructor will determine the length
   *                   by calling `u_strlen()`.
   * @stable ICU 2.0
   */
  UnicodeString(UBool isTerminated,
                ConstChar16Ptr text,
                int32_t textLength);

  /**
   * Writable-aliasing char16_t* constructor.
   * The text will be used for the UnicodeString object, but
   * it will not be released when the UnicodeString is destroyed.
   * This has write-through semantics:
   * For as long as the capacity of the buffer is sufficient, write operations
   * will directly affect the buffer. When more capacity is necessary, then
   * a new buffer will be allocated and the contents copied as with regularly
   * constructed strings.
   * In an assignment to another UnicodeString, the buffer will be copied.
   * The extract(Char16Ptr dst) function detects whether the dst pointer is the same
   * as the string buffer itself and will in this case not copy the contents.
   *
   * @param buffer The characters to alias for the UnicodeString.
   * @param buffLength The number of Unicode characters in `buffer` to alias.
   * @param buffCapacity The size of `buffer` in char16_ts.
   * @stable ICU 2.0
   */
  UnicodeString(char16_t *buffer, int32_t buffLength, int32_t buffCapacity);

#if !U_CHAR16_IS_TYPEDEF
  /**
   * Writable-aliasing uint16_t * constructor.
   * Delegates to UnicodeString(const char16_t *, int32_t, int32_t).
   * @param buffer writable buffer of/for UTF-16 text
   * @param buffLength length of the current buffer contents
   * @param buffCapacity buffer capacity
   * @stable ICU 59
   */
  UnicodeString(uint16_t *buffer, int32_t buffLength, int32_t buffCapacity) :
      UnicodeString(Char16Ptr(buffer), buffLength, buffCapacity) {}
#endif

#if U_SIZEOF_WCHAR_T==2 || defined(U_IN_DOXYGEN)
  /**
   * Writable-aliasing wchar_t * constructor.
   * (Only defined if U_SIZEOF_WCHAR_T==2.)
   * Delegates to UnicodeString(const char16_t *, int32_t, int32_t).
   * @param buffer writable buffer of/for UTF-16 text
   * @param buffLength length of the current buffer contents
   * @param buffCapacity buffer capacity
   * @stable ICU 59
   */
  UnicodeString(wchar_t *buffer, int32_t buffLength, int32_t buffCapacity) :
      UnicodeString(Char16Ptr(buffer), buffLength, buffCapacity) {}
#endif

  /**
   * Writable-aliasing nullptr_t constructor.
   * Effectively the same as the default constructor, makes an empty string object.
   * @param buffer nullptr
   * @param buffLength ignored
   * @param buffCapacity ignored
   * @stable ICU 59
   */
  inline UnicodeString(std::nullptr_t buffer, int32_t buffLength, int32_t buffCapacity);

#if U_CHARSET_IS_UTF8 || !UCONFIG_NO_CONVERSION

  /**
   * char* constructor.
   * Uses the default converter (and thus depends on the ICU conversion code)
   * unless U_CHARSET_IS_UTF8 is set to 1.
   *
   * For ASCII (really "invariant character") strings it is more efficient to use
   * the constructor that takes a US_INV (for its enum EInvariant).
   *
   * Note, for string literals:
   * Since C++17 and ICU 76, you can use UTF-16 string literals with compile-time
   * length determination:
   * \code
   * UnicodeString str(u"literal");
   * if (str == u"other literal") { ... }
   * \endcode
   *
   * It is recommended to mark this constructor "explicit" by
   * `-DUNISTR_FROM_STRING_EXPLICIT=explicit`
   * on the compiler command line or similar.
   * @param codepageData an array of bytes, null-terminated,
   *                     in the platform's default codepage.
   * @stable ICU 2.0
   */
  UNISTR_FROM_STRING_EXPLICIT UnicodeString(const char *codepageData);

  /**
   * char* constructor.
   * Uses the default converter (and thus depends on the ICU conversion code)
   * unless U_CHARSET_IS_UTF8 is set to 1.
   * @param codepageData an array of bytes in the platform's default codepage.
   * @param dataLength The number of bytes in `codepageData`.
   * @stable ICU 2.0
   */
  UnicodeString(const char *codepageData, int32_t dataLength);

#endif

#if !UCONFIG_NO_CONVERSION

  /**
   * char* constructor.
   * @param codepageData an array of bytes, null-terminated
   * @param codepage the encoding of `codepageData`.  The special
   * value 0 for `codepage` indicates that the text is in the
   * platform's default codepage.
   *
   * If `codepage` is an empty string (`""`),
   * then a simple conversion is performed on the codepage-invariant
   * subset ("invariant characters") of the platform encoding. See utypes.h.
   * Recommendation: For invariant-character strings use the constructor
   * UnicodeString(const char *src, int32_t length, enum EInvariant inv)
   * because it avoids object code dependencies of UnicodeString on
   * the conversion code.
   *
   * @stable ICU 2.0
   */
  UnicodeString(const char *codepageData, const char *codepage);

  /**
   * char* constructor.
   * @param codepageData an array of bytes.
   * @param dataLength The number of bytes in `codepageData`.
   * @param codepage the encoding of `codepageData`.  The special
   * value 0 for `codepage` indicates that the text is in the
   * platform's default codepage.
   * If `codepage` is an empty string (`""`),
   * then a simple conversion is performed on the codepage-invariant
   * subset ("invariant characters") of the platform encoding. See utypes.h.
   * Recommendation: For invariant-character strings use the constructor
   * UnicodeString(const char *src, int32_t length, enum EInvariant inv)
   * because it avoids object code dependencies of UnicodeString on
   * the conversion code.
   *
   * @stable ICU 2.0
   */
  UnicodeString(const char *codepageData, int32_t dataLength, const char *codepage);

  /**
   * char * / UConverter constructor.
   * This constructor uses an existing UConverter object to
   * convert the codepage string to Unicode and construct a UnicodeString
   * from that.
   *
   * The converter is reset at first.
   * If the error code indicates a failure before this constructor is called,
   * or if an error occurs during conversion or construction,
   * then the string will be bogus.
   *
   * This function avoids the overhead of opening and closing a converter if
   * multiple strings are constructed.
   *
   * @param src input codepage string
   * @param srcLength length of the input string, can be -1 for NUL-terminated strings
   * @param cnv converter object (ucnv_resetToUnicode() will be called),
   *        can be nullptr for the default converter
   * @param errorCode normal ICU error code
   * @stable ICU 2.0
   */
  UnicodeString(
        const char *src, int32_t srcLength,
        UConverter *cnv,
        UErrorCode &errorCode);

#endif

  /**
   * Constructs a Unicode string from an invariant-character char * string.
   * About invariant characters see utypes.h.
   * This constructor has no runtime dependency on conversion code and is
   * therefore recommended over ones taking a charset name string
   * (where the empty string "" indicates invariant-character conversion).
   *
   * Use the macro US_INV as the third, signature-distinguishing parameter.
   *
   * For example:
   * \code
   *     void fn(const char *s) {
   *       UnicodeString ustr(s, -1, US_INV);
   *       // use ustr ...
   *     }
   * \endcode
   *
   * Note, for string literals:
   * Since C++17 and ICU 76, you can use UTF-16 string literals with compile-time
   * length determination:
   * \code
   * UnicodeString str(u"literal");
   * if (str == u"other literal") { ... }
   * \endcode
   *
   * @param src String using only invariant characters.
   * @param textLength Length of src, or -1 if NUL-terminated.
   * @param inv Signature-distinguishing parameter, use US_INV.
   *
   * @see US_INV
   * @stable ICU 3.2
   */
  UnicodeString(const char *src, int32_t textLength, enum EInvariant inv);


  /**
   * Copy constructor.
   *
   * Starting with ICU 2.4, the assignment operator and the copy constructor
   * allocate a new buffer and copy the buffer contents even for readonly aliases.
   * By contrast, the fastCopyFrom() function implements the old,
   * more efficient but less safe behavior
   * of making this string also a readonly alias to the same buffer.
   *
   * If the source object has an "open" buffer from getBuffer(minCapacity),
   * then the copy is an empty string.
   *
   * @param that The UnicodeString object to copy.
   * @stable ICU 2.0
   * @see fastCopyFrom
   */
  UnicodeString(const UnicodeString& that);

  /**
   * Move constructor; might leave src in bogus state.
   * This string will have the same contents and state that the source string had.
   * @param src source string
   * @stable ICU 56
   */
  UnicodeString(UnicodeString &&src) noexcept;

  /**
   * 'Substring' constructor from tail of source string.
   * @param src The UnicodeString object to copy.
   * @param srcStart The offset into `src` at which to start copying.
   * @stable ICU 2.2
   */
  UnicodeString(const UnicodeString& src, int32_t srcStart);

  /**
   * 'Substring' constructor from subrange of source string.
   * @param src The UnicodeString object to copy.
   * @param srcStart The offset into `src` at which to start copying.
   * @param srcLength The number of characters from `src` to copy.
   * @stable ICU 2.2
   */
  UnicodeString(const UnicodeString& src, int32_t srcStart, int32_t srcLength);

  /**
   * Clone this object, an instance of a subclass of Replaceable.
   * Clones can be used concurrently in multiple threads.
   * If a subclass does not implement clone(), or if an error occurs,
   * then nullptr is returned.
   * The caller must delete the clone.
   *
   * @return a clone of this object
   *
   * @see Replaceable::clone
   * @see getDynamicClassID
   * @stable ICU 2.6
   */
  virtual UnicodeString *clone() const override;

  /** Destructor.
   * @stable ICU 2.0
   */
  virtual ~UnicodeString();

  /**
   * Readonly-aliasing factory method.
   * Aliases the same buffer as the input `text`
   * which is, or which is implicitly convertible to,
   * a std::u16string_view or (if U_SIZEOF_WCHAR_T==2) std::wstring_view.
   * The string is bogus if the string view is too long.
   *
   * The text will be used for the UnicodeString object, but
   * it will not be released when the UnicodeString is destroyed.
   * This has copy-on-write semantics:
   * When the string is modified, then the buffer is first copied into
   * newly allocated memory.
   * The aliased buffer is never modified.
   *
   * In an assignment to another UnicodeString, when using the copy constructor
   * or the assignment operator, the text will be copied.
   * When using fastCopyFrom(), the text will be aliased again,
   * so that both strings then alias the same readonly-text.
   *
   * @param text The string view to alias for the UnicodeString.
   * @stable ICU 76
   */
  template<typename S, typename = std::enable_if_t<ConvertibleToU16StringView<S>>>
  static inline UnicodeString readOnlyAlias(const S &text) {
    return readOnlyAliasFromU16StringView(internal::toU16StringView(text));
  }

  /**
   * Readonly-aliasing factory method.
   * Aliases the same buffer as the input `text`.
   *
   * The text will be used for the UnicodeString object, but
   * it will not be released when the UnicodeString is destroyed.
   * This has copy-on-write semantics:
   * When the string is modified, then the buffer is first copied into
   * newly allocated memory.
   * The aliased buffer is never modified.
   *
   * In an assignment to another UnicodeString, when using the copy constructor
   * or the assignment operator, the text will be copied.
   * When using fastCopyFrom(), the text will be aliased again,
   * so that both strings then alias the same readonly-text.
   *
   * @param text The UnicodeString to alias.
   * @stable ICU 76
   */
  static inline UnicodeString readOnlyAlias(const UnicodeString &text) {
    return readOnlyAliasFromUnicodeString(text);
  }

  /**
   * Create a UnicodeString from a UTF-8 string.
   * Illegal input is replaced with U+FFFD. Otherwise, errors result in a bogus string.
   * Calls u_strFromUTF8WithSub().
   *
   * @param utf8 UTF-8 input string.
   *             Note that a StringPiece can be implicitly constructed
   *             from a std::string or a NUL-terminated const char * string.
   * @return A UnicodeString with equivalent UTF-16 contents.
   * @see toUTF8
   * @see toUTF8String
   * @stable ICU 4.2
   */
  static UnicodeString fromUTF8(StringPiece utf8);

  /**
   * Create a UnicodeString from a UTF-32 string.
   * Illegal input is replaced with U+FFFD. Otherwise, errors result in a bogus string.
   * Calls u_strFromUTF32WithSub().
   *
   * @param utf32 UTF-32 input string. Must not be nullptr.
   * @param length Length of the input string, or -1 if NUL-terminated.
   * @return A UnicodeString with equivalent UTF-16 contents.
   * @see toUTF32
   * @stable ICU 4.2
   */
  static UnicodeString fromUTF32(const UChar32 *utf32, int32_t length);

  /* Miscellaneous operations */

  /**
   * Unescape a string of characters and return a string containing
   * the result.  The following escape sequences are recognized:
   *
   * \\uhhhh       4 hex digits; h in [0-9A-Fa-f]
   * \\Uhhhhhhhh   8 hex digits
   * \\xhh         1-2 hex digits
   * \\ooo         1-3 octal digits; o in [0-7]
   * \\cX          control-X; X is masked with 0x1F
   *
   * as well as the standard ANSI C escapes:
   *
   * \\a => U+0007, \\b => U+0008, \\t => U+0009, \\n => U+000A,
   * \\v => U+000B, \\f => U+000C, \\r => U+000D, \\e => U+001B,
   * \\" => U+0022, \\' => U+0027, \\? => U+003F, \\\\ => U+005C
   *
   * Anything else following a backslash is generically escaped.  For
   * example, "[a\\-z]" returns "[a-z]".
   *
   * If an escape sequence is ill-formed, this method returns an empty
   * string.  An example of an ill-formed sequence is "\\u" followed by
   * fewer than 4 hex digits.
   *
   * This function is similar to u_unescape() but not identical to it.
   * The latter takes a source char*, so it does escape recognition
   * and also invariant conversion.
   *
   * @return a string with backslash escapes interpreted, or an
   * empty string on error.
   * @see UnicodeString#unescapeAt()
   * @see u_unescape()
   * @see u_unescapeAt()
   * @stable ICU 2.0
   */
  UnicodeString unescape() const;

  /**
   * Unescape a single escape sequence and return the represented
   * character.  See unescape() for a listing of the recognized escape
   * sequences.  The character at offset-1 is assumed (without
   * checking) to be a backslash.  If the escape sequence is
   * ill-formed, or the offset is out of range, U_SENTINEL=-1 is
   * returned.
   *
   * @param offset an input output parameter.  On input, it is the
   * offset into this string where the escape sequence is located,
   * after the initial backslash.  On output, it is advanced after the
   * last character parsed.  On error, it is not advanced at all.
   * @return the character represented by the escape sequence at
   * offset, or U_SENTINEL=-1 on error.
   * @see UnicodeString#unescape()
   * @see u_unescape()
   * @see u_unescapeAt()
   * @stable ICU 2.0
   */
  UChar32 unescapeAt(int32_t &offset) const;

  /**
   * ICU "poor man's RTTI", returns a UClassID for this class.
   *
   * @stable ICU 2.2
   */
  static UClassID U_EXPORT2 getStaticClassID();

  /**
   * ICU "poor man's RTTI", returns a UClassID for the actual class.
   *
   * @stable ICU 2.2
   */
  virtual UClassID getDynamicClassID() const override;

  //========================================
  // Implementation methods
  //========================================

protected:
  /**
   * Implement Replaceable::getLength() (see jitterbug 1027).
   * @stable ICU 2.4
   */
  virtual int32_t getLength() const override;

  /**
   * The change in Replaceable to use virtual getCharAt() allows
   * UnicodeString::charAt() to be inline again (see jitterbug 709).
   * @stable ICU 2.4
   */
  virtual char16_t getCharAt(int32_t offset) const override;

  /**
   * The change in Replaceable to use virtual getChar32At() allows
   * UnicodeString::char32At() to be inline again (see jitterbug 709).
   * @stable ICU 2.4
   */
  virtual UChar32 getChar32At(int32_t offset) const override;

private:
  static UnicodeString readOnlyAliasFromU16StringView(std::u16string_view text);
  static UnicodeString readOnlyAliasFromUnicodeString(const UnicodeString &text);

  // For char* constructors. Could be made public.
  UnicodeString &setToUTF8(StringPiece utf8);
  // For extract(char*).
  // We could make a toUTF8(target, capacity, errorCode) public but not
  // this version: New API will be cleaner if we make callers create substrings
  // rather than having start+length on every method,
  // and it should take a UErrorCode&.
  int32_t
  toUTF8(int32_t start, int32_t len,
         char *target, int32_t capacity) const;

  /**
   * Internal string contents comparison, called by operator==.
   * Requires: this & text not bogus and have same lengths.
   */
  inline UBool doEquals(const UnicodeString &text, int32_t len) const {
    return doEquals(text.getArrayStart(), len);
  }
  UBool doEquals(const char16_t *text, int32_t len) const;

  inline UBool
  doEqualsSubstring(int32_t start,
           int32_t length,
           const UnicodeString& srcText,
           int32_t srcStart,
           int32_t srcLength) const;

  UBool doEqualsSubstring(int32_t start,
           int32_t length,
           const char16_t *srcChars,
           int32_t srcStart,
           int32_t srcLength) const;

  inline int8_t
  doCompare(int32_t start,
           int32_t length,
           const UnicodeString& srcText,
           int32_t srcStart,
           int32_t srcLength) const;

  int8_t doCompare(int32_t start,
           int32_t length,
           const char16_t *srcChars,
           int32_t srcStart,
           int32_t srcLength) const;

  inline int8_t
  doCompareCodePointOrder(int32_t start,
                          int32_t length,
                          const UnicodeString& srcText,
                          int32_t srcStart,
                          int32_t srcLength) const;

  int8_t doCompareCodePointOrder(int32_t start,
                                 int32_t length,
                                 const char16_t *srcChars,
                                 int32_t srcStart,
                                 int32_t srcLength) const;

  inline int8_t
  doCaseCompare(int32_t start,
                int32_t length,
                const UnicodeString &srcText,
                int32_t srcStart,
                int32_t srcLength,
                uint32_t options) const;

  int8_t
  doCaseCompare(int32_t start,
                int32_t length,
                const char16_t *srcChars,
                int32_t srcStart,
                int32_t srcLength,
                uint32_t options) const;

  int32_t doIndexOf(char16_t c,
            int32_t start,
            int32_t length) const;

  int32_t doIndexOf(UChar32 c,
                        int32_t start,
                        int32_t length) const;

  int32_t doLastIndexOf(char16_t c,
                int32_t start,
                int32_t length) const;

  int32_t doLastIndexOf(UChar32 c,
                            int32_t start,
                            int32_t length) const;

  void doExtract(int32_t start,
         int32_t length,
         char16_t *dst,
         int32_t dstStart) const;

  inline void doExtract(int32_t start,
         int32_t length,
         UnicodeString& target) const;

  inline char16_t doCharAt(int32_t offset)  const;

  UnicodeString& doReplace(int32_t start,
               int32_t length,
               const UnicodeString& srcText,
               int32_t srcStart,
               int32_t srcLength);

  UnicodeString& doReplace(int32_t start,
               int32_t length,
               const char16_t *srcChars,
               int32_t srcStart,
               int32_t srcLength);
  UnicodeString& doReplace(int32_t start, int32_t length, std::u16string_view src);

  UnicodeString& doAppend(const UnicodeString& src, int32_t srcStart, int32_t srcLength);
  UnicodeString& doAppend(const char16_t *srcChars, int32_t srcStart, int32_t srcLength);
  UnicodeString& doAppend(std::u16string_view src);

  UnicodeString& doReverse(int32_t start,
               int32_t length);

  // calculate hash code
  int32_t doHashCode() const;

  // get pointer to start of array
  // these do not check for kOpenGetBuffer, unlike the public getBuffer() function
  inline char16_t* getArrayStart();
  inline const char16_t* getArrayStart() const;

  inline UBool hasShortLength() const;
  inline int32_t getShortLength() const;

  // A UnicodeString object (not necessarily its current buffer)
  // is writable unless it isBogus() or it has an "open" getBuffer(minCapacity).
  inline UBool isWritable() const;

  // Is the current buffer writable?
  inline UBool isBufferWritable() const;

  // None of the following does releaseArray().
  inline void setZeroLength();
  inline void setShortLength(int32_t len);
  inline void setLength(int32_t len);
  inline void setToEmpty();
  inline void setArray(char16_t *array, int32_t len, int32_t capacity); // sets length but not flags

  // allocate the array; result may be the stack buffer
  // sets refCount to 1 if appropriate
  // sets fArray, fCapacity, and flags
  // sets length to 0
  // returns boolean for success or failure
  UBool allocate(int32_t capacity);

  // release the array if owned
  void releaseArray();

  // turn a bogus string into an empty one
  void unBogus();

  // implements assignment operator, copy constructor, and fastCopyFrom()
  UnicodeString &copyFrom(const UnicodeString &src, UBool fastCopy=false);

  // Copies just the fields without memory management.
  void copyFieldsFrom(UnicodeString &src, UBool setSrcToBogus) noexcept;

  // Pin start and limit to acceptable values.
  inline void pinIndex(int32_t& start) const;
  inline void pinIndices(int32_t& start,
                         int32_t& length) const;

#if !UCONFIG_NO_CONVERSION

  /* Internal extract() using UConverter. */
  int32_t doExtract(int32_t start, int32_t length,
                    char *dest, int32_t destCapacity,
                    UConverter *cnv,
                    UErrorCode &errorCode) const;

  /*
   * Real constructor for converting from codepage data.
   * It assumes that it is called with !fRefCounted.
   *
   * If `codepage==0`, then the default converter
   * is used for the platform encoding.
   * If `codepage` is an empty string (`""`),
   * then a simple conversion is performed on the codepage-invariant
   * subset ("invariant characters") of the platform encoding. See utypes.h.
   */
  void doCodepageCreate(const char *codepageData,
                        int32_t dataLength,
                        const char *codepage);

  /*
   * Worker function for creating a UnicodeString from
   * a codepage string using a UConverter.
   */
  void
  doCodepageCreate(const char *codepageData,
                   int32_t dataLength,
                   UConverter *converter,
                   UErrorCode &status);

#endif

  /*
   * This function is called when write access to the array
   * is necessary.
   *
   * We need to make a copy of the array if
   * the buffer is read-only, or
   * the buffer is refCounted (shared), and refCount>1, or
   * the buffer is too small.
   *
   * Return false if memory could not be allocated.
   */
  UBool cloneArrayIfNeeded(int32_t newCapacity = -1,
                           int32_t growCapacity = -1,
                           UBool doCopyArray = true,
                           int32_t** pBufferToDelete = nullptr,
                           UBool forceClone = false);

  /**
   * Common function for UnicodeString case mappings.
   * The stringCaseMapper has the same type UStringCaseMapper
   * as in ustr_imp.h for ustrcase_map().
   */
  UnicodeString &
  caseMap(int32_t caseLocale, uint32_t options,
#if !UCONFIG_NO_BREAK_ITERATION
          BreakIterator *iter,
#endif
          UStringCaseMapper *stringCaseMapper);

  // ref counting
  void addRef();
  int32_t removeRef();
  int32_t refCount() const;

  // constants
  enum {
    /**
     * Size of stack buffer for short strings.
     * Must be at least U16_MAX_LENGTH for the single-code point constructor to work.
     * @see UNISTR_OBJECT_SIZE
     */
    US_STACKBUF_SIZE = static_cast<int32_t>(UNISTR_OBJECT_SIZE - sizeof(void*) - 2) / U_SIZEOF_UCHAR,
    kInvalidUChar=0xffff, // U+FFFF returned by charAt(invalid index)
    kInvalidHashCode=0, // invalid hash code
    kEmptyHashCode=1, // hash code for empty string

    // bit flag values for fLengthAndFlags
    kIsBogus=1,         // this string is bogus, i.e., not valid or nullptr
    kUsingStackBuffer=2,// using fUnion.fStackFields instead of fUnion.fFields
    kRefCounted=4,      // there is a refCount field before the characters in fArray
    kBufferIsReadonly=8,// do not write to this buffer
    kOpenGetBuffer=16,  // getBuffer(minCapacity) was called (is "open"),
                        // and releaseBuffer(newLength) must be called
    kAllStorageFlags=0x1f,

    kLengthShift=5,     // remaining 11 bits for non-negative short length, or negative if long
    kLength1=1<<kLengthShift,
    kMaxShortLength=0x3ff,  // max non-negative short length (leaves top bit 0)
    kLengthIsLarge=0xffe0,  // short length < 0, real length is in fUnion.fFields.fLength

    // combined values for convenience
    kShortString=kUsingStackBuffer,
    kLongString=kRefCounted,
    kReadonlyAlias=kBufferIsReadonly,
    kWritableAlias=0
  };

  friend class UnicodeStringAppendable;

  union StackBufferOrFields;        // forward declaration necessary before friend declaration
  friend union StackBufferOrFields; // make US_STACKBUF_SIZE visible inside fUnion

  /*
   * The following are all the class fields that are stored
   * in each UnicodeString object.
   * Note that UnicodeString has virtual functions,
   * therefore there is an implicit vtable pointer
   * as the first real field.
   * The fields should be aligned such that no padding is necessary.
   * On 32-bit machines, the size should be 32 bytes,
   * on 64-bit machines (8-byte pointers), it should be 40 bytes.
   *
   * We use a hack to achieve this.
   *
   * With at least some compilers, each of the following is forced to
   * a multiple of sizeof(pointer) [the largest field base unit here is a data pointer],
   * rounded up with additional padding if the fields do not already fit that requirement:
   * - sizeof(class UnicodeString)
   * - offsetof(UnicodeString, fUnion)
   * - sizeof(fUnion)
   * - sizeof(fStackFields)
   *
   * We optimize for the longest possible internal buffer for short strings.
   * fUnion.fStackFields begins with 2 bytes for storage flags
   * and the length of relatively short strings,
   * followed by the buffer for short string contents.
   * There is no padding inside fStackFields.
   *
   * Heap-allocated and aliased strings use fUnion.fFields.
   * Both fStackFields and fFields must begin with the same fields for flags and short length,
   * that is, those must have the same memory offsets inside the object,
   * because the flags must be inspected in order to decide which half of fUnion is being used.
   * We assume that the compiler does not reorder the fields.
   *
   * (Padding at the end of fFields is ok:
   * As long as it is no larger than fStackFields, it is not wasted space.)
   *
   * For some of the history of the UnicodeString class fields layout, see
   * - ICU ticket #11551 "longer UnicodeString contents in stack buffer"
   * - ICU ticket #11336 "UnicodeString: recombine stack buffer arrays"
   * - ICU ticket #8322 "why is sizeof(UnicodeString)==48?"
   */
  // (implicit) *vtable;
  union StackBufferOrFields {
    // fStackFields is used iff (fLengthAndFlags&kUsingStackBuffer) else fFields is used.
    // Each struct of the union must begin with fLengthAndFlags.
    struct {
      int16_t fLengthAndFlags;          // bit fields: see constants above
      char16_t fBuffer[US_STACKBUF_SIZE];  // buffer for short strings
    } fStackFields;
    struct {
      int16_t fLengthAndFlags;          // bit fields: see constants above
      int32_t fLength;    // number of characters in fArray if >127; else undefined
      int32_t fCapacity;  // capacity of fArray (in char16_ts)
      // array pointer last to minimize padding for machines with P128 data model
      // or pointer sizes that are not a power of 2
      char16_t   *fArray;    // the Unicode data
    } fFields;
  } fUnion;
};

/**
 * Creates a new UnicodeString from the concatenation of two others.
 *
 * @param s1 The first string to be copied to the new one.
 * @param s2 The second string to be copied to the new one, after s1.
 * @return UnicodeString(s1).append(s2)
 * @stable ICU 2.8
 */
U_COMMON_API UnicodeString U_EXPORT2
operator+ (const UnicodeString &s1, const UnicodeString &s2);

/**
 * Creates a new UnicodeString from the concatenation of a UnicodeString and `s2`
 * which is, or which is implicitly convertible to,
 * a std::u16string_view or (if U_SIZEOF_WCHAR_T==2) std::wstring_view.
 *
 * @param s1 The string to be copied to the new one.
 * @param s2 The string view to be copied to the new string, after s1.
 * @return UnicodeString(s1).append(s2)
 * @stable ICU 76
 */
template<
    typename US, typename S,
    typename = std::enable_if_t<ConvertibleToU16StringView<S> && std::is_same_v<US, UnicodeString>>>
inline UnicodeString operator+(const US &s1, const S &s2) {
  return unistr_internalConcat(s1, internal::toU16StringView(s2));
}

#ifndef U_FORCE_HIDE_INTERNAL_API
/** @internal */
U_COMMON_API UnicodeString U_EXPORT2
unistr_internalConcat(const UnicodeString &s1, std::u16string_view s2);
#endif

//========================================
// Inline members
//========================================

//========================================
// Privates
//========================================

inline void
UnicodeString::pinIndex(int32_t& start) const
{
  // pin index
  if(start < 0) {
    start = 0;
  } else if(start > length()) {
    start = length();
  }
}

inline void
UnicodeString::pinIndices(int32_t& start,
                          int32_t& _length) const
{
  // pin indices
  int32_t len = length();
  if(start < 0) {
    start = 0;
  } else if(start > len) {
    start = len;
  }
  if(_length < 0) {
    _length = 0;
  } else if(_length > (len - start)) {
    _length = (len - start);
  }
}

inline char16_t*
UnicodeString::getArrayStart() {
  return (fUnion.fFields.fLengthAndFlags&kUsingStackBuffer) ?
    fUnion.fStackFields.fBuffer : fUnion.fFields.fArray;
}

inline const char16_t*
UnicodeString::getArrayStart() const {
  return (fUnion.fFields.fLengthAndFlags&kUsingStackBuffer) ?
    fUnion.fStackFields.fBuffer : fUnion.fFields.fArray;
}

//========================================
// Default constructor
//========================================

inline
UnicodeString::UnicodeString() {
  fUnion.fStackFields.fLengthAndFlags=kShortString;
}

inline UnicodeString::UnicodeString(const std::nullptr_t /*text*/) {
  fUnion.fStackFields.fLengthAndFlags=kShortString;
}

inline UnicodeString::UnicodeString(const std::nullptr_t /*text*/, int32_t /*length*/) {
  fUnion.fStackFields.fLengthAndFlags=kShortString;
}

inline UnicodeString::UnicodeString(std::nullptr_t /*buffer*/, int32_t /*buffLength*/, int32_t /*buffCapacity*/) {
  fUnion.fStackFields.fLengthAndFlags=kShortString;
}

//========================================
// Read-only implementation methods
//========================================
inline UBool
UnicodeString::hasShortLength() const {
  return fUnion.fFields.fLengthAndFlags>=0;
}

inline int32_t
UnicodeString::getShortLength() const {
  // fLengthAndFlags must be non-negative -> short length >= 0
  // and arithmetic or logical shift does not matter.
  return fUnion.fFields.fLengthAndFlags>>kLengthShift;
}

inline int32_t
UnicodeString::length() const {
  return hasShortLength() ? getShortLength() : fUnion.fFields.fLength;
}

inline int32_t
UnicodeString::getCapacity() const {
  return (fUnion.fFields.fLengthAndFlags&kUsingStackBuffer) ?
    US_STACKBUF_SIZE : fUnion.fFields.fCapacity;
}

inline int32_t
UnicodeString::hashCode() const
{ return doHashCode(); }

inline UBool
UnicodeString::isBogus() const
{ return fUnion.fFields.fLengthAndFlags & kIsBogus; }

inline UBool
UnicodeString::isWritable() const
{ return !(fUnion.fFields.fLengthAndFlags & (kOpenGetBuffer | kIsBogus)); }

inline UBool
UnicodeString::isBufferWritable() const
{
  return
      !(fUnion.fFields.fLengthAndFlags&(kOpenGetBuffer|kIsBogus|kBufferIsReadonly)) &&
      (!(fUnion.fFields.fLengthAndFlags&kRefCounted) || refCount()==1);
}

inline const char16_t *
UnicodeString::getBuffer() const {
  if(fUnion.fFields.fLengthAndFlags&(kIsBogus|kOpenGetBuffer)) {
    return nullptr;
  } else if(fUnion.fFields.fLengthAndFlags&kUsingStackBuffer) {
    return fUnion.fStackFields.fBuffer;
  } else {
    return fUnion.fFields.fArray;
  }
}

//========================================
// Read-only alias methods
//========================================
inline int8_t
UnicodeString::doCompare(int32_t start,
              int32_t thisLength,
              const UnicodeString& srcText,
              int32_t srcStart,
              int32_t srcLength) const
{
  if(srcText.isBogus()) {
    return static_cast<int8_t>(!isBogus()); // 0 if both are bogus, 1 otherwise
  } else {
    srcText.pinIndices(srcStart, srcLength);
    return doCompare(start, thisLength, srcText.getArrayStart(), srcStart, srcLength);
  }
}

inline UBool
UnicodeString::doEqualsSubstring(int32_t start,
              int32_t thisLength,
              const UnicodeString& srcText,
              int32_t srcStart,
              int32_t srcLength) const
{
  if(srcText.isBogus()) {
    return isBogus();
  } else {
    srcText.pinIndices(srcStart, srcLength);
    return !isBogus() && doEqualsSubstring(start, thisLength, srcText.getArrayStart(), srcStart, srcLength);
  }
}

inline bool
UnicodeString::operator== (const UnicodeString& text) const
{
  if(isBogus()) {
    return text.isBogus();
  } else {
    int32_t len = length(), textLength = text.length();
    return !text.isBogus() && len == textLength && doEquals(text, len);
  }
}

inline bool
UnicodeString::operator!= (const UnicodeString& text) const
{ return (! operator==(text)); }

inline UBool
UnicodeString::operator> (const UnicodeString& text) const
{ return doCompare(0, length(), text, 0, text.length()) == 1; }

inline UBool
UnicodeString::operator< (const UnicodeString& text) const
{ return doCompare(0, length(), text, 0, text.length()) == -1; }

inline UBool
UnicodeString::operator>= (const UnicodeString& text) const
{ return doCompare(0, length(), text, 0, text.length()) != -1; }

inline UBool
UnicodeString::operator<= (const UnicodeString& text) const
{ return doCompare(0, length(), text, 0, text.length()) != 1; }

inline int8_t
UnicodeString::compare(const UnicodeString& text) const
{ return doCompare(0, length(), text, 0, text.length()); }

inline int8_t
UnicodeString::compare(int32_t start,
               int32_t _length,
               const UnicodeString& srcText) const
{ return doCompare(start, _length, srcText, 0, srcText.length()); }

inline int8_t
UnicodeString::compare(ConstChar16Ptr srcChars,
               int32_t srcLength) const
{ return doCompare(0, length(), srcChars, 0, srcLength); }

inline int8_t
UnicodeString::compare(int32_t start,
               int32_t _length,
               const UnicodeString& srcText,
               int32_t srcStart,
               int32_t srcLength) const
{ return doCompare(start, _length, srcText, srcStart, srcLength); }

inline int8_t
UnicodeString::compare(int32_t start,
               int32_t _length,
               const char16_t *srcChars) const
{ return doCompare(start, _length, srcChars, 0, _length); }

inline int8_t
UnicodeString::compare(int32_t start,
               int32_t _length,
               const char16_t *srcChars,
               int32_t srcStart,
               int32_t srcLength) const
{ return doCompare(start, _length, srcChars, srcStart, srcLength); }

inline int8_t
UnicodeString::compareBetween(int32_t start,
                  int32_t limit,
                  const UnicodeString& srcText,
                  int32_t srcStart,
                  int32_t srcLimit) const
{ return doCompare(start, limit - start,
           srcText, srcStart, srcLimit - srcStart); }

inline int8_t
UnicodeString::doCompareCodePointOrder(int32_t start,
                                       int32_t thisLength,
                                       const UnicodeString& srcText,
                                       int32_t srcStart,
                                       int32_t srcLength) const
{
  if(srcText.isBogus()) {
    return static_cast<int8_t>(!isBogus()); // 0 if both are bogus, 1 otherwise
  } else {
    srcText.pinIndices(srcStart, srcLength);
    return doCompareCodePointOrder(start, thisLength, srcText.getArrayStart(), srcStart, srcLength);
  }
}

inline int8_t
UnicodeString::compareCodePointOrder(const UnicodeString& text) const
{ return doCompareCodePointOrder(0, length(), text, 0, text.length()); }

inline int8_t
UnicodeString::compareCodePointOrder(int32_t start,
                                     int32_t _length,
                                     const UnicodeString& srcText) const
{ return doCompareCodePointOrder(start, _length, srcText, 0, srcText.length()); }

inline int8_t
UnicodeString::compareCodePointOrder(ConstChar16Ptr srcChars,
                                     int32_t srcLength) const
{ return doCompareCodePointOrder(0, length(), srcChars, 0, srcLength); }

inline int8_t
UnicodeString::compareCodePointOrder(int32_t start,
                                     int32_t _length,
                                     const UnicodeString& srcText,
                                     int32_t srcStart,
                                     int32_t srcLength) const
{ return doCompareCodePointOrder(start, _length, srcText, srcStart, srcLength); }

inline int8_t
UnicodeString::compareCodePointOrder(int32_t start,
                                     int32_t _length,
                                     const char16_t *srcChars) const
{ return doCompareCodePointOrder(start, _length, srcChars, 0, _length); }

inline int8_t
UnicodeString::compareCodePointOrder(int32_t start,
                                     int32_t _length,
                                     const char16_t *srcChars,
                                     int32_t srcStart,
                                     int32_t srcLength) const
{ return doCompareCodePointOrder(start, _length, srcChars, srcStart, srcLength); }

inline int8_t
UnicodeString::compareCodePointOrderBetween(int32_t start,
                                            int32_t limit,
                                            const UnicodeString& srcText,
                                            int32_t srcStart,
                                            int32_t srcLimit) const
{ return doCompareCodePointOrder(start, limit - start,
           srcText, srcStart, srcLimit - srcStart); }

inline int8_t
UnicodeString::doCaseCompare(int32_t start,
                             int32_t thisLength,
                             const UnicodeString &srcText,
                             int32_t srcStart,
                             int32_t srcLength,
                             uint32_t options) const
{
  if(srcText.isBogus()) {
    return static_cast<int8_t>(!isBogus()); // 0 if both are bogus, 1 otherwise
  } else {
    srcText.pinIndices(srcStart, srcLength);
    return doCaseCompare(start, thisLength, srcText.getArrayStart(), srcStart, srcLength, options);
  }
}

inline int8_t
UnicodeString::caseCompare(const UnicodeString &text, uint32_t options) const {
  return doCaseCompare(0, length(), text, 0, text.length(), options);
}

inline int8_t
UnicodeString::caseCompare(int32_t start,
                           int32_t _length,
                           const UnicodeString &srcText,
                           uint32_t options) const {
  return doCaseCompare(start, _length, srcText, 0, srcText.length(), options);
}

inline int8_t
UnicodeString::caseCompare(ConstChar16Ptr srcChars,
                           int32_t srcLength,
                           uint32_t options) const {
  return doCaseCompare(0, length(), srcChars, 0, srcLength, options);
}

inline int8_t
UnicodeString::caseCompare(int32_t start,
                           int32_t _length,
                           const UnicodeString &srcText,
                           int32_t srcStart,
                           int32_t srcLength,
                           uint32_t options) const {
  return doCaseCompare(start, _length, srcText, srcStart, srcLength, options);
}

inline int8_t
UnicodeString::caseCompare(int32_t start,
                           int32_t _length,
                           const char16_t *srcChars,
                           uint32_t options) const {
  return doCaseCompare(start, _length, srcChars, 0, _length, options);
}

inline int8_t
UnicodeString::caseCompare(int32_t start,
                           int32_t _length,
                           const char16_t *srcChars,
                           int32_t srcStart,
                           int32_t srcLength,
                           uint32_t options) const {
  return doCaseCompare(start, _length, srcChars, srcStart, srcLength, options);
}

inline int8_t
UnicodeString::caseCompareBetween(int32_t start,
                                  int32_t limit,
                                  const UnicodeString &srcText,
                                  int32_t srcStart,
                                  int32_t srcLimit,
                                  uint32_t options) const {
  return doCaseCompare(start, limit - start, srcText, srcStart, srcLimit - srcStart, options);
}

inline int32_t
UnicodeString::indexOf(const UnicodeString& srcText,
               int32_t srcStart,
               int32_t srcLength,
               int32_t start,
               int32_t _length) const
{
  if(!srcText.isBogus()) {
    srcText.pinIndices(srcStart, srcLength);
    if(srcLength > 0) {
      return indexOf(srcText.getArrayStart(), srcStart, srcLength, start, _length);
    }
  }
  return -1;
}

inline int32_t
UnicodeString::indexOf(const UnicodeString& text) const
{ return indexOf(text, 0, text.length(), 0, length()); }

inline int32_t
UnicodeString::indexOf(const UnicodeString& text,
               int32_t start) const {
  pinIndex(start);
  return indexOf(text, 0, text.length(), start, length() - start);
}

inline int32_t
UnicodeString::indexOf(const UnicodeString& text,
               int32_t start,
               int32_t _length) const
{ return indexOf(text, 0, text.length(), start, _length); }

inline int32_t
UnicodeString::indexOf(const char16_t *srcChars,
               int32_t srcLength,
               int32_t start) const {
  pinIndex(start);
  return indexOf(srcChars, 0, srcLength, start, length() - start);
}

inline int32_t
UnicodeString::indexOf(ConstChar16Ptr srcChars,
               int32_t srcLength,
               int32_t start,
               int32_t _length) const
{ return indexOf(srcChars, 0, srcLength, start, _length); }

inline int32_t
UnicodeString::indexOf(char16_t c,
               int32_t start,
               int32_t _length) const
{ return doIndexOf(c, start, _length); }

inline int32_t
UnicodeString::indexOf(UChar32 c,
               int32_t start,
               int32_t _length) const
{ return doIndexOf(c, start, _length); }

inline int32_t
UnicodeString::indexOf(char16_t c) const
{ return doIndexOf(c, 0, length()); }

inline int32_t
UnicodeString::indexOf(UChar32 c) const
{ return indexOf(c, 0, length()); }

inline int32_t
UnicodeString::indexOf(char16_t c,
               int32_t start) const {
  pinIndex(start);
  return doIndexOf(c, start, length() - start);
}

inline int32_t
UnicodeString::indexOf(UChar32 c,
               int32_t start) const {
  pinIndex(start);
  return indexOf(c, start, length() - start);
}

inline int32_t
UnicodeString::lastIndexOf(ConstChar16Ptr srcChars,
               int32_t srcLength,
               int32_t start,
               int32_t _length) const
{ return lastIndexOf(srcChars, 0, srcLength, start, _length); }

inline int32_t
UnicodeString::lastIndexOf(const char16_t *srcChars,
               int32_t srcLength,
               int32_t start) const {
  pinIndex(start);
  return lastIndexOf(srcChars, 0, srcLength, start, length() - start);
}

inline int32_t
UnicodeString::lastIndexOf(const UnicodeString& srcText,
               int32_t srcStart,
               int32_t srcLength,
               int32_t start,
               int32_t _length) const
{
  if(!srcText.isBogus()) {
    srcText.pinIndices(srcStart, srcLength);
    if(srcLength > 0) {
      return lastIndexOf(srcText.getArrayStart(), srcStart, srcLength, start, _length);
    }
  }
  return -1;
}

inline int32_t
UnicodeString::lastIndexOf(const UnicodeString& text,
               int32_t start,
               int32_t _length) const
{ return lastIndexOf(text, 0, text.length(), start, _length); }

inline int32_t
UnicodeString::lastIndexOf(const UnicodeString& text,
               int32_t start) const {
  pinIndex(start);
  return lastIndexOf(text, 0, text.length(), start, length() - start);
}

inline int32_t
UnicodeString::lastIndexOf(const UnicodeString& text) const
{ return lastIndexOf(text, 0, text.length(), 0, length()); }

inline int32_t
UnicodeString::lastIndexOf(char16_t c,
               int32_t start,
               int32_t _length) const
{ return doLastIndexOf(c, start, _length); }

inline int32_t
UnicodeString::lastIndexOf(UChar32 c,
               int32_t start,
               int32_t _length) const {
  return doLastIndexOf(c, start, _length);
}

inline int32_t
UnicodeString::lastIndexOf(char16_t c) const
{ return doLastIndexOf(c, 0, length()); }

inline int32_t
UnicodeString::lastIndexOf(UChar32 c) const {
  return lastIndexOf(c, 0, length());
}

inline int32_t
UnicodeString::lastIndexOf(char16_t c,
               int32_t start) const {
  pinIndex(start);
  return doLastIndexOf(c, start, length() - start);
}

inline int32_t
UnicodeString::lastIndexOf(UChar32 c,
               int32_t start) const {
  pinIndex(start);
  return lastIndexOf(c, start, length() - start);
}

inline UBool
UnicodeString::startsWith(const UnicodeString& text) const
{ return doEqualsSubstring(0, text.length(), text, 0, text.length()); }

inline UBool
UnicodeString::startsWith(const UnicodeString& srcText,
              int32_t srcStart,
              int32_t srcLength) const
{ return doEqualsSubstring(0, srcLength, srcText, srcStart, srcLength); }

inline UBool
UnicodeString::startsWith(ConstChar16Ptr srcChars, int32_t srcLength) const {
  if(srcLength < 0) {
    srcLength = u_strlen(toUCharPtr(srcChars));
  }
  return doEqualsSubstring(0, srcLength, srcChars, 0, srcLength);
}

inline UBool
UnicodeString::startsWith(const char16_t *srcChars, int32_t srcStart, int32_t srcLength) const {
  if(srcLength < 0) {
    srcLength = u_strlen(toUCharPtr(srcChars));
  }
  return doEqualsSubstring(0, srcLength, srcChars, srcStart, srcLength);
}

inline UBool
UnicodeString::endsWith(const UnicodeString& text) const
{ return doEqualsSubstring(length() - text.length(), text.length(),
           text, 0, text.length()); }

inline UBool
UnicodeString::endsWith(const UnicodeString& srcText,
            int32_t srcStart,
            int32_t srcLength) const {
  srcText.pinIndices(srcStart, srcLength);
  return doEqualsSubstring(length() - srcLength, srcLength,
                   srcText, srcStart, srcLength);
}

inline UBool
UnicodeString::endsWith(ConstChar16Ptr srcChars,
            int32_t srcLength) const {
  if(srcLength < 0) {
    srcLength = u_strlen(toUCharPtr(srcChars));
  }
  return doEqualsSubstring(length() - srcLength, srcLength, srcChars, 0, srcLength);
}

inline UBool
UnicodeString::endsWith(const char16_t *srcChars,
            int32_t srcStart,
            int32_t srcLength) const {
  if(srcLength < 0) {
    srcLength = u_strlen(toUCharPtr(srcChars + srcStart));
  }
  return doEqualsSubstring(length() - srcLength, srcLength,
                   srcChars, srcStart, srcLength);
}

//========================================
// replace
//========================================
inline UnicodeString&
UnicodeString::replace(int32_t start,
               int32_t _length,
               const UnicodeString& srcText)
{ return doReplace(start, _length, srcText, 0, srcText.length()); }

inline UnicodeString&
UnicodeString::replace(int32_t start,
               int32_t _length,
               const UnicodeString& srcText,
               int32_t srcStart,
               int32_t srcLength)
{ return doReplace(start, _length, srcText, srcStart, srcLength); }

inline UnicodeString&
UnicodeString::replace(int32_t start,
               int32_t _length,
               ConstChar16Ptr srcChars,
               int32_t srcLength)
{ return doReplace(start, _length, srcChars, 0, srcLength); }

inline UnicodeString&
UnicodeString::replace(int32_t start,
               int32_t _length,
               const char16_t *srcChars,
               int32_t srcStart,
               int32_t srcLength)
{ return doReplace(start, _length, srcChars, srcStart, srcLength); }

inline UnicodeString&
UnicodeString::replace(int32_t start,
               int32_t _length,
               char16_t srcChar)
{ return doReplace(start, _length, &srcChar, 0, 1); }

inline UnicodeString&
UnicodeString::replaceBetween(int32_t start,
                  int32_t limit,
                  const UnicodeString& srcText)
{ return doReplace(start, limit - start, srcText, 0, srcText.length()); }

inline UnicodeString&
UnicodeString::replaceBetween(int32_t start,
                  int32_t limit,
                  const UnicodeString& srcText,
                  int32_t srcStart,
                  int32_t srcLimit)
{ return doReplace(start, limit - start, srcText, srcStart, srcLimit - srcStart); }

inline UnicodeString&
UnicodeString::findAndReplace(const UnicodeString& oldText,
                  const UnicodeString& newText)
{ return findAndReplace(0, length(), oldText, 0, oldText.length(),
            newText, 0, newText.length()); }

inline UnicodeString&
UnicodeString::findAndReplace(int32_t start,
                  int32_t _length,
                  const UnicodeString& oldText,
                  const UnicodeString& newText)
{ return findAndReplace(start, _length, oldText, 0, oldText.length(),
            newText, 0, newText.length()); }

// ============================
// extract
// ============================
inline void
UnicodeString::doExtract(int32_t start,
             int32_t _length,
             UnicodeString& target) const
{ target.replace(0, target.length(), *this, start, _length); }

inline void
UnicodeString::extract(int32_t start,
               int32_t _length,
               Char16Ptr target,
               int32_t targetStart) const
{ doExtract(start, _length, target, targetStart); }

inline void
UnicodeString::extract(int32_t start,
               int32_t _length,
               UnicodeString& target) const
{ doExtract(start, _length, target); }

#if !UCONFIG_NO_CONVERSION

inline int32_t
UnicodeString::extract(int32_t start,
               int32_t _length,
               char *dst,
               const char *codepage) const

{
  // This dstSize value will be checked explicitly
  return extract(start, _length, dst, dst != nullptr ? 0xffffffff : 0, codepage);
}

#endif

inline void
UnicodeString::extractBetween(int32_t start,
                  int32_t limit,
                  char16_t *dst,
                  int32_t dstStart) const {
  pinIndex(start);
  pinIndex(limit);
  doExtract(start, limit - start, dst, dstStart);
}

inline UnicodeString
UnicodeString::tempSubStringBetween(int32_t start, int32_t limit) const {
    return tempSubString(start, limit - start);
}

inline char16_t
UnicodeString::doCharAt(int32_t offset) const
{
  if (static_cast<uint32_t>(offset) < static_cast<uint32_t>(length())) {
    return getArrayStart()[offset];
  } else {
    return kInvalidUChar;
  }
}

inline char16_t
UnicodeString::charAt(int32_t offset) const
{ return doCharAt(offset); }

inline char16_t
UnicodeString::operator[] (int32_t offset) const
{ return doCharAt(offset); }

inline UBool
UnicodeString::isEmpty() const {
  // Arithmetic or logical right shift does not matter: only testing for 0.
  return (fUnion.fFields.fLengthAndFlags>>kLengthShift) == 0;
}

//========================================
// Write implementation methods
//========================================
inline void
UnicodeString::setZeroLength() {
  fUnion.fFields.fLengthAndFlags &= kAllStorageFlags;
}

inline void
UnicodeString::setShortLength(int32_t len) {
  // requires 0 <= len <= kMaxShortLength
  fUnion.fFields.fLengthAndFlags =
    static_cast<int16_t>((fUnion.fFields.fLengthAndFlags & kAllStorageFlags) | (len << kLengthShift));
}

inline void
UnicodeString::setLength(int32_t len) {
  if(len <= kMaxShortLength) {
    setShortLength(len);
  } else {
    fUnion.fFields.fLengthAndFlags |= kLengthIsLarge;
    fUnion.fFields.fLength = len;
  }
}

inline void
UnicodeString::setToEmpty() {
  fUnion.fFields.fLengthAndFlags = kShortString;
}

inline void
UnicodeString::setArray(char16_t *array, int32_t len, int32_t capacity) {
  setLength(len);
  fUnion.fFields.fArray = array;
  fUnion.fFields.fCapacity = capacity;
}

inline UnicodeString&
UnicodeString::operator= (char16_t ch)
{ return doReplace(0, length(), &ch, 0, 1); }

inline UnicodeString&
UnicodeString::operator= (UChar32 ch)
{ return replace(0, length(), ch); }

inline UnicodeString&
UnicodeString::setTo(const UnicodeString& srcText,
             int32_t srcStart,
             int32_t srcLength)
{
  unBogus();
  return doReplace(0, length(), srcText, srcStart, srcLength);
}

inline UnicodeString&
UnicodeString::setTo(const UnicodeString& srcText,
             int32_t srcStart)
{
  unBogus();
  srcText.pinIndex(srcStart);
  return doReplace(0, length(), srcText, srcStart, srcText.length() - srcStart);
}

inline UnicodeString&
UnicodeString::setTo(const UnicodeString& srcText)
{
  return copyFrom(srcText);
}

inline UnicodeString&
UnicodeString::setTo(const char16_t *srcChars,
             int32_t srcLength)
{
  unBogus();
  return doReplace(0, length(), srcChars, 0, srcLength);
}

inline UnicodeString&
UnicodeString::setTo(char16_t srcChar)
{
  unBogus();
  return doReplace(0, length(), &srcChar, 0, 1);
}

inline UnicodeString&
UnicodeString::setTo(UChar32 srcChar)
{
  unBogus();
  return replace(0, length(), srcChar);
}

inline UnicodeString&
UnicodeString::append(const UnicodeString& srcText,
              int32_t srcStart,
              int32_t srcLength)
{ return doAppend(srcText, srcStart, srcLength); }

inline UnicodeString&
UnicodeString::append(const UnicodeString& srcText)
{ return doAppend(srcText, 0, srcText.length()); }

inline UnicodeString&
UnicodeString::append(const char16_t *srcChars,
              int32_t srcStart,
              int32_t srcLength)
{ return doAppend(srcChars, srcStart, srcLength); }

inline UnicodeString&
UnicodeString::append(ConstChar16Ptr srcChars,
              int32_t srcLength)
{ return doAppend(srcChars, 0, srcLength); }

inline UnicodeString&
UnicodeString::append(char16_t srcChar)
{ return doAppend(&srcChar, 0, 1); }

inline UnicodeString&
UnicodeString::operator+= (char16_t ch)
{ return doAppend(&ch, 0, 1); }

inline UnicodeString&
UnicodeString::operator+= (UChar32 ch) {
  return append(ch);
}

inline UnicodeString&
UnicodeString::operator+= (const UnicodeString& srcText)
{ return doAppend(srcText, 0, srcText.length()); }

inline UnicodeString&
UnicodeString::insert(int32_t start,
              const UnicodeString& srcText,
              int32_t srcStart,
              int32_t srcLength)
{ return doReplace(start, 0, srcText, srcStart, srcLength); }

inline UnicodeString&
UnicodeString::insert(int32_t start,
              const UnicodeString& srcText)
{ return doReplace(start, 0, srcText, 0, srcText.length()); }

inline UnicodeString&
UnicodeString::insert(int32_t start,
              const char16_t *srcChars,
              int32_t srcStart,
              int32_t srcLength)
{ return doReplace(start, 0, srcChars, srcStart, srcLength); }

inline UnicodeString&
UnicodeString::insert(int32_t start,
              ConstChar16Ptr srcChars,
              int32_t srcLength)
{ return doReplace(start, 0, srcChars, 0, srcLength); }

inline UnicodeString&
UnicodeString::insert(int32_t start,
              char16_t srcChar)
{ return doReplace(start, 0, &srcChar, 0, 1); }

inline UnicodeString&
UnicodeString::insert(int32_t start,
              UChar32 srcChar)
{ return replace(start, 0, srcChar); }


inline UnicodeString&
UnicodeString::remove()
{
  // remove() of a bogus string makes the string empty and non-bogus
  if(isBogus()) {
    setToEmpty();
  } else {
    setZeroLength();
  }
  return *this;
}

inline UnicodeString&
UnicodeString::remove(int32_t start,
             int32_t _length)
{
    if(start <= 0 && _length == INT32_MAX) {
        // remove(guaranteed everything) of a bogus string makes the string empty and non-bogus
        return remove();
    }
    return doReplace(start, _length, nullptr, 0, 0);
}

inline UnicodeString&
UnicodeString::removeBetween(int32_t start,
                int32_t limit)
{ return doReplace(start, limit - start, nullptr, 0, 0); }

inline UnicodeString &
UnicodeString::retainBetween(int32_t start, int32_t limit) {
  truncate(limit);
  return doReplace(0, start, nullptr, 0, 0);
}

inline UBool
UnicodeString::truncate(int32_t targetLength)
{
  if(isBogus() && targetLength == 0) {
    // truncate(0) of a bogus string makes the string empty and non-bogus
    unBogus();
    return false;
  } else if (static_cast<uint32_t>(targetLength) < static_cast<uint32_t>(length())) {
    setLength(targetLength);
    return true;
  } else {
    return false;
  }
}

inline UnicodeString&
UnicodeString::reverse()
{ return doReverse(0, length()); }

inline UnicodeString&
UnicodeString::reverse(int32_t start,
               int32_t _length)
{ return doReverse(start, _length); }

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
