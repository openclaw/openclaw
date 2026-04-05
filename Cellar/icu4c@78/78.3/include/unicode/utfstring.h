// © 2025 and later: Unicode, Inc. and others.
// License & terms of use: https://www.unicode.org/copyright.html

// utfstring.h
// created: 2025jul18 Markus W. Scherer

#ifndef __UTFSTRING_H__
#define __UTFSTRING_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API || U_SHOW_CPLUSPLUS_HEADER_API || !defined(UTYPES_H)

#include "unicode/utf16.h"

/**
 * \file
 * \brief C++ header-only API: C++ string helper functions.
 */

#ifndef U_HIDE_DRAFT_API

namespace U_HEADER_ONLY_NAMESPACE {
namespace utfstring {

// Write code points to strings -------------------------------------------- ***

#ifndef U_IN_DOXYGEN
namespace prv {

// This function, and the public wrappers,
// want to be U_FORCE_INLINE but the gcc-debug-build-and-test CI check failed with
// error: ‘always_inline’ function might not be inlinable [-Werror=attributes]
template<typename StringClass, bool validate>
inline StringClass &appendCodePoint(StringClass &s, uint32_t c) {
    using Unit = typename StringClass::value_type;
    if constexpr (sizeof(Unit) == 1) {
        // UTF-8: Similar to U8_APPEND().
        if (c <= 0x7f) {
            s.push_back(static_cast<Unit>(c));
        } else {
            Unit buf[4];
            uint8_t len;
            if (c <= 0x7ff) {
                len = 2;
                buf[2] = (c >> 6) | 0xc0;
            } else {
                if (validate ?
                        c < 0xd800 ||
                            (c < 0xe000 || c > 0x10ffff ? (c = 0xfffd, true) : c <= 0xffff) :
                        c <= 0xffff) {
                    len = 3;
                    buf[1] = (c >> 12) | 0xe0;
                } else {
                    len = 4;
                    buf[0] = (c >> 18) | 0xf0;
                    buf[1] = ((c >> 12) & 0x3f) | 0x80;
                }
                buf[2] = ((c >> 6) & 0x3f) | 0x80;
            }
            buf[3] = (c & 0x3f) | 0x80;
            s.append(buf + 4 - len, len);
        }
    } else if constexpr (sizeof(Unit) == 2) {
        // UTF-16: Similar to U16_APPEND().
        if (validate ?
                c < 0xd800 || (c < 0xe000 || c > 0x10ffff ? (c = 0xfffd, true) : c <= 0xffff) :
                c <= 0xffff) {
            s.push_back(static_cast<Unit>(c));
        } else {
            Unit buf[2] = { U16_LEAD(c), U16_TRAIL(c) };
            s.append(buf, 2);
        }
    } else {
        // UTF-32
        s.push_back(!validate || U_IS_SCALAR_VALUE(c) ? c : 0xfffd);
    }
    return s;
}

}  // namespace prv
#endif  // U_IN_DOXYGEN

#ifndef U_HIDE_DRAFT_API
/**
 * Appends the code point to the string.
 * Appends the U+FFFD replacement character instead if c is not a scalar value.
 * See https://www.unicode.org/glossary/#unicode_scalar_value
 *
 * @tparam StringClass A version of std::basic_string (or a compatible type)
 * @param s The string to append to
 * @param c The code point to append
 * @return s
 * @draft ICU 78
 * @see U_IS_SCALAR_VALUE
 */
template<typename StringClass>
inline StringClass &appendOrFFFD(StringClass &s, UChar32 c) {
    return prv::appendCodePoint<StringClass, true>(s, c);
}

/**
 * Appends the code point to the string.
 * The code point must be a scalar value; otherwise the behavior is undefined.
 * See https://www.unicode.org/glossary/#unicode_scalar_value
 *
 * @tparam StringClass A version of std::basic_string (or a compatible type)
 * @param s The string to append to
 * @param c The code point to append (must be a scalar value)
 * @return s
 * @draft ICU 78
 * @see U_IS_SCALAR_VALUE
 */
template<typename StringClass>
inline StringClass &appendUnsafe(StringClass &s, UChar32 c) {
    return prv::appendCodePoint<StringClass, false>(s, c);
}

/**
 * Returns the code point as a string of code units.
 * Returns the U+FFFD replacement character instead if c is not a scalar value.
 * See https://www.unicode.org/glossary/#unicode_scalar_value
 *
 * @tparam StringClass A version of std::basic_string (or a compatible type)
 * @param c The code point
 * @return the string of c's code units
 * @draft ICU 78
 * @see U_IS_SCALAR_VALUE
 */
template<typename StringClass>
inline StringClass encodeOrFFFD(UChar32 c) {
    StringClass s;
    prv::appendCodePoint<StringClass, true>(s, c);
    return s;
}

/**
 * Returns the code point as a string of code units.
 * The code point must be a scalar value; otherwise the behavior is undefined.
 * See https://www.unicode.org/glossary/#unicode_scalar_value
 *
 * @tparam StringClass A version of std::basic_string (or a compatible type)
 * @param c The code point
 * @return the string of c's code units
 * @draft ICU 78
 * @see U_IS_SCALAR_VALUE
 */
template<typename StringClass>
inline StringClass encodeUnsafe(UChar32 c) {
    StringClass s;
    prv::appendCodePoint<StringClass, false>(s, c);
    return s;
}
#endif  // U_HIDE_DRAFT_API

}  // namespace utfstring
}  // namespace U_HEADER_ONLY_NAMESPACE

#endif  // U_HIDE_DRAFT_API
#endif  // U_SHOW_CPLUSPLUS_API || U_SHOW_CPLUSPLUS_HEADER_API
#endif  // __UTFSTRING_H__
