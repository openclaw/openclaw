// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*
*   Copyright (C) 2002-2012, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
*******************************************************************************
*   file name:  utf_old.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2002sep21
*   created by: Markus W. Scherer
*/

/**
 * \file
 * \brief C API: Deprecated macros for Unicode string handling
 *
 * The macros in utf_old.h are all deprecated and their use discouraged.
 * Some of the design principles behind the set of UTF macros
 * have changed or proved impractical.
 * Almost all of the old "UTF macros" are at least renamed.
 * If you are looking for a new equivalent to an old macro, please see the
 * comment at the old one.
 *
 * Brief summary of reasons for deprecation:
 * - Switch on UTF_SIZE (selection of UTF-8/16/32 default string processing)
 *   was impractical.
 * - Switch on UTF_SAFE etc. (selection of unsafe/safe/strict default string processing)
 *   was of little use and impractical.
 * - Whole classes of macros became obsolete outside of the UTF_SIZE/UTF_SAFE
 *   selection framework: UTF32_ macros (all trivial)
 *   and UTF_ default and intermediate macros (all aliases).
 * - The selection framework also caused many macro aliases.
 * - Change in Unicode standard: "irregular" sequences (3.0) became illegal (3.2).
 * - Change of language in Unicode standard:
 *   Growing distinction between internal x-bit Unicode strings and external UTF-x
 *   forms, with the former more lenient.
 *   Suggests renaming of UTF16_ macros to U16_.
 * - The prefix "UTF_" without a width number confused some users.
 * - "Safe" append macros needed the addition of an error indicator output.
 * - "Safe" UTF-8 macros used legitimate (if rarely used) code point values
 *   to indicate error conditions.
 * - The use of the "_CHAR" infix for code point operations confused some users.
 *
 * More details:
 *
 * Until ICU 2.2, utf.h theoretically allowed to choose among UTF-8/16/32
 * for string processing, and among unsafe/safe/strict default macros for that.
 *
 * It proved nearly impossible to write non-trivial, high-performance code
 * that is UTF-generic.
 * Unsafe default macros would be dangerous for default string processing,
 * and the main reason for the "strict" versions disappeared:
 * Between Unicode 3.0 and 3.2 all "irregular" UTF-8 sequences became illegal.
 * The only other conditions that "strict" checked for were non-characters,
 * which are valid during processing. Only during text input/output should they
 * be checked, and at that time other well-formedness checks may be
 * necessary or useful as well.
 * This can still be done by using U16_NEXT and U_IS_UNICODE_NONCHAR
 * or U_IS_UNICODE_CHAR.
 *
 * The old UTF8_..._SAFE macros also used some normal Unicode code points
 * to indicate malformed sequences.
 * The new UTF8_ macros without suffix use negative values instead.
 *
 * The entire contents of utf32.h was moved here without replacement
 * because all those macros were trivial and
 * were meaningful only in the framework of choosing the UTF size.
 *
 * See Jitterbug 2150 and its discussion on the ICU mailing list
 * in September 2002.
 *
 * <hr>
 *
 * <em>Obsolete part</em> of pre-ICU 2.4 utf.h file documentation:
 *
 * <p>The original concept for these files was for ICU to allow
 * in principle to set which UTF (UTF-8/16/32) is used internally
 * by defining UTF_SIZE to either 8, 16, or 32. utf.h would then define the UChar type
 * accordingly. UTF-16 was the default.</p>
 *
 * <p>This concept has been abandoned.
 * A lot of the ICU source code assumes UChar strings are in UTF-16.
 * This is especially true for low-level code like
 * conversion, normalization, and collation.
 * The utf.h header enforces the default of UTF-16.
 * The UTF-8 and UTF-32 macros remain for now for completeness and backward compatibility.</p>
 *
 * <p>Accordingly, utf.h defines UChar to be an unsigned 16-bit integer. If this matches wchar_t, then
 * UChar is defined to be exactly wchar_t, otherwise uint16_t.</p>
 *
 * <p>UChar32 is defined to be a signed 32-bit integer (int32_t), large enough for a 21-bit
 * Unicode code point (Unicode scalar value, 0..0x10ffff).
 * Before ICU 2.4, the definition of UChar32 was similarly platform-dependent as
 * the definition of UChar. For details see the documentation for UChar32 itself.</p>
 *
 * <p>utf.h also defines a number of C macros for handling single Unicode code points and
 * for using UTF Unicode strings. It includes utf8.h, utf16.h, and utf32.h for the actual
 * implementations of those macros and then aliases one set of them (for UTF-16) for general use.
 * The UTF-specific macros have the UTF size in the macro name prefixes (UTF16_...), while
 * the general alias macros always begin with UTF_...</p>
 *
 * <p>Many string operations can be done with or without error checking.
 * Where such a distinction is useful, there are two versions of the macros, "unsafe" and "safe"
 * ones with ..._UNSAFE and ..._SAFE suffixes. The unsafe macros are fast but may cause
 * program failures if the strings are not well-formed. The safe macros have an additional, boolean
 * parameter "strict". If strict is false, then only illegal sequences are detected.
 * Otherwise, irregular sequences and non-characters are detected as well (like single surrogates).
 * Safe macros return special error code points for illegal/irregular sequences:
 * Typically, U+ffff, or values that would result in a code unit sequence of the same length
 * as the erroneous input sequence.<br>
 * Note that _UNSAFE macros have fewer parameters: They do not have the strictness parameter, and
 * they do not have start/length parameters for boundary checking.</p>
 *
 * <p>Here, the macros are aliased in two steps:
 * In the first step, the UTF-specific macros with UTF16_ prefix and _UNSAFE and _SAFE suffixes are
 * aliased according to the UTF_SIZE to macros with UTF_ prefix and the same suffixes and signatures.
 * Then, in a second step, the default, general alias macros are set to use either the unsafe or
 * the safe/not strict (default) or the safe/strict macro;
 * these general macros do not have a strictness parameter.</p>
 *
 * <p>It is possible to change the default choice for the general alias macros to be unsafe, safe/not strict or safe/strict.
 * The default is safe/not strict. It is not recommended to select the unsafe macros as the basis for
 * Unicode string handling in ICU! To select this, define UTF_SAFE, UTF_STRICT, or UTF_UNSAFE.</p>
 *
 * <p>For general use, one should use the default, general macros with UTF_ prefix and no _SAFE/_UNSAFE suffix.
 * Only in some cases it may be necessary to control the choice of macro directly and use a less generic alias.
 * For example, if it can be assumed that a string is well-formed and the index will stay within the bounds,
 * then the _UNSAFE version may be used.
 * If a UTF-8 string is to be processed, then the macros with UTF8_ prefixes need to be used.</p>
 *
 * <hr>
 *
 * Deprecated ICU 2.4. Use the macros in utf.h, utf16.h, utf8.h instead.
 */

#ifndef __UTF_OLD_H__
#define __UTF_OLD_H__

#include "unicode/utf.h"
#include "unicode/utf8.h"
#include "unicode/utf16.h"

/**
 * \def U_HIDE_OBSOLETE_UTF_OLD_H
 *
 * Hides the obsolete definitions in unicode/utf_old.h.
 * Recommended to be set to 1 at compile time to make sure
 * the long-deprecated macros are no longer used.
 *
 * For reasons for the deprecation see the utf_old.h file comments.
 *
 * @internal
 */
#ifndef U_HIDE_OBSOLETE_UTF_OLD_H
#   define U_HIDE_OBSOLETE_UTF_OLD_H 0
#endif

#if !defined(U_HIDE_DEPRECATED_API) && !U_HIDE_OBSOLETE_UTF_OLD_H

/* Formerly utf.h, part 1 --------------------------------------------------- */

#ifdef U_USE_UTF_DEPRECATES
/**
 * Unicode string and array offset and index type.
 * ICU always counts Unicode code units (UChars) for
 * string offsets, indexes, and lengths, not Unicode code points.
 *
 * @obsolete ICU 2.6. Use int32_t directly instead since this API will be removed in that release.
 */
typedef int32_t UTextOffset;
#endif

/** Number of bits in a Unicode string code unit - ICU uses 16-bit Unicode. @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF_SIZE 16

/**
 * The default choice for general Unicode string macros is to use the ..._SAFE macro implementations
 * with strict=false.
 *
 * @deprecated ICU 2.4. Obsolete, see utf_old.h.
 */
#define UTF_SAFE
/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#undef UTF_UNSAFE
/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#undef UTF_STRICT

/**
 * UTF8_ERROR_VALUE_1 and UTF8_ERROR_VALUE_2 are special error values for UTF-8,
 * which need 1 or 2 bytes in UTF-8:
 * \code
 * U+0015 = NAK = Negative Acknowledge, C0 control character
 * U+009f = highest C1 control character
 * \endcode
 *
 * These are used by UTF8_..._SAFE macros so that they can return an error value
 * that needs the same number of code units (bytes) as were seen by
 * a macro. They should be tested with UTF_IS_ERROR() or UTF_IS_VALID().
 *
 * @deprecated ICU 2.4. Obsolete, see utf_old.h.
 */
#define UTF8_ERROR_VALUE_1 0x15

/**
 * See documentation on UTF8_ERROR_VALUE_1 for details.
 *
 * @deprecated ICU 2.4. Obsolete, see utf_old.h.
 */
#define UTF8_ERROR_VALUE_2 0x9f

/**
 * Error value for all UTFs. This code point value will be set by macros with error
 * checking if an error is detected.
 *
 * @deprecated ICU 2.4. Obsolete, see utf_old.h.
 */
#define UTF_ERROR_VALUE 0xffff

/**
 * Is a given 32-bit code an error value
 * as returned by one of the macros for any UTF?
 *
 * @deprecated ICU 2.4. Obsolete, see utf_old.h.
 */
#define UTF_IS_ERROR(c) \
    (((c)&0xfffe)==0xfffe || (c)==UTF8_ERROR_VALUE_1 || (c)==UTF8_ERROR_VALUE_2)

/**
 * This is a combined macro: Is c a valid Unicode value _and_ not an error code?
 *
 * @deprecated ICU 2.4. Obsolete, see utf_old.h.
 */
#define UTF_IS_VALID(c) \
    (UTF_IS_UNICODE_CHAR(c) && \
     (c)!=UTF8_ERROR_VALUE_1 && (c)!=UTF8_ERROR_VALUE_2)

/**
 * Is this code unit or code point a surrogate (U+d800..U+dfff)?
 * @deprecated ICU 2.4. Renamed to U_IS_SURROGATE and U16_IS_SURROGATE, see utf_old.h.
 */
#define UTF_IS_SURROGATE(uchar) (((uchar)&0xfffff800)==0xd800)

/**
 * Is a given 32-bit code point a Unicode noncharacter?
 *
 * @deprecated ICU 2.4. Renamed to U_IS_UNICODE_NONCHAR, see utf_old.h.
 */
#define UTF_IS_UNICODE_NONCHAR(c) \
    ((c)>=0xfdd0 && \
     ((uint32_t)(c)<=0xfdef || ((c)&0xfffe)==0xfffe) && \
     (uint32_t)(c)<=0x10ffff)

/**
 * Is a given 32-bit value a Unicode code point value (0..U+10ffff)
 * that can be assigned a character?
 *
 * Code points that are not characters include:
 * - single surrogate code points (U+d800..U+dfff, 2048 code points)
 * - the last two code points on each plane (U+__fffe and U+__ffff, 34 code points)
 * - U+fdd0..U+fdef (new with Unicode 3.1, 32 code points)
 * - the highest Unicode code point value is U+10ffff
 *
 * This means that all code points below U+d800 are character code points,
 * and that boundary is tested first for performance.
 *
 * @deprecated ICU 2.4. Renamed to U_IS_UNICODE_CHAR, see utf_old.h.
 */
#define UTF_IS_UNICODE_CHAR(c) \
    ((uint32_t)(c)<0xd800 || \
        ((uint32_t)(c)>0xdfff && \
         (uint32_t)(c)<=0x10ffff && \
         !UTF_IS_UNICODE_NONCHAR(c)))

/* Formerly utf8.h ---------------------------------------------------------- */

/**
* \var utf8_countTrailBytes
* Internal array with numbers of trail bytes for any given byte used in
* lead byte position.
*
* This is internal since it is not meant to be called directly by external clients;
* however it is called by public macros in this file and thus must remain stable,
* and should not be hidden when other internal functions are hidden (otherwise
* public macros would fail to compile).
* @internal
*/
#ifdef U_UTF8_IMPL
// No forward declaration if compiling utf_impl.cpp, which defines utf8_countTrailBytes.
#elif defined(U_STATIC_IMPLEMENTATION) || defined(U_COMMON_IMPLEMENTATION)
U_CAPI const uint8_t utf8_countTrailBytes[];
#else
U_CFUNC U_IMPORT const uint8_t utf8_countTrailBytes[];
#endif 

/**
 * Count the trail bytes for a UTF-8 lead byte.
 * @deprecated ICU 2.4. Renamed to U8_COUNT_TRAIL_BYTES, see utf_old.h.
 */
#define UTF8_COUNT_TRAIL_BYTES(leadByte) (utf8_countTrailBytes[(uint8_t)leadByte])

/**
 * Mask a UTF-8 lead byte, leave only the lower bits that form part of the code point value.
 * @deprecated ICU 2.4. Renamed to U8_MASK_LEAD_BYTE, see utf_old.h.
 */
#define UTF8_MASK_LEAD_BYTE(leadByte, countTrailBytes) ((leadByte)&=(1<<(6-(countTrailBytes)))-1)

/** Is this this code point a single code unit (byte)? @deprecated ICU 2.4. Renamed to U8_IS_SINGLE, see utf_old.h. */
#define UTF8_IS_SINGLE(uchar) (((uchar)&0x80)==0)
/** Is this this code unit the lead code unit (byte) of a code point? @deprecated ICU 2.4. Renamed to U8_IS_LEAD, see utf_old.h. */
#define UTF8_IS_LEAD(uchar) ((uint8_t)((uchar)-0xc0)<0x3e)
/** Is this this code unit a trailing code unit (byte) of a code point? @deprecated ICU 2.4. Renamed to U8_IS_TRAIL, see utf_old.h. */
#define UTF8_IS_TRAIL(uchar) (((uchar)&0xc0)==0x80)

/** Does this scalar Unicode value need multiple code units for storage? @deprecated ICU 2.4. Use U8_LENGTH or test ((uint32_t)(c)>0x7f) instead, see utf_old.h. */
#define UTF8_NEED_MULTIPLE_UCHAR(c) ((uint32_t)(c)>0x7f)

/**
 * Given the lead character, how many bytes are taken by this code point.
 * ICU does not deal with code points >0x10ffff
 * unless necessary for advancing in the byte stream.
 *
 * These length macros take into account that for values >0x10ffff
 * the UTF8_APPEND_CHAR_SAFE macros would write the error code point 0xffff
 * with 3 bytes.
 * Code point comparisons need to be in uint32_t because UChar32
 * may be a signed type, and negative values must be recognized.
 *
 * @deprecated ICU 2.4. Use U8_LENGTH instead, see utf.h.
 */
#if 1
#   define UTF8_CHAR_LENGTH(c) \
        ((uint32_t)(c)<=0x7f ? 1 : \
            ((uint32_t)(c)<=0x7ff ? 2 : \
                ((uint32_t)((c)-0x10000)>0xfffff ? 3 : 4) \
            ) \
        )
#else
#   define UTF8_CHAR_LENGTH(c) \
        ((uint32_t)(c)<=0x7f ? 1 : \
            ((uint32_t)(c)<=0x7ff ? 2 : \
                ((uint32_t)(c)<=0xffff ? 3 : \
                    ((uint32_t)(c)<=0x10ffff ? 4 : \
                        ((uint32_t)(c)<=0x3ffffff ? 5 : \
                            ((uint32_t)(c)<=0x7fffffff ? 6 : 3) \
                        ) \
                    ) \
                ) \
            ) \
        )
#endif

/** The maximum number of bytes per code point. @deprecated ICU 2.4. Renamed to U8_MAX_LENGTH, see utf_old.h. */
#define UTF8_MAX_CHAR_LENGTH 4

/** Average number of code units compared to UTF-16. @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF8_ARRAY_SIZE(size) ((5*(size))/2)

/** @deprecated ICU 2.4. Renamed to U8_GET_UNSAFE, see utf_old.h. */
#define UTF8_GET_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    int32_t _utf8_get_char_unsafe_index=(int32_t)(i); \
    UTF8_SET_CHAR_START_UNSAFE(s, _utf8_get_char_unsafe_index); \
    UTF8_NEXT_CHAR_UNSAFE(s, _utf8_get_char_unsafe_index, c); \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Use U8_GET instead, see utf_old.h. */
#define UTF8_GET_CHAR_SAFE(s, start, i, length, c, strict) UPRV_BLOCK_MACRO_BEGIN { \
    int32_t _utf8_get_char_safe_index=(int32_t)(i); \
    UTF8_SET_CHAR_START_SAFE(s, start, _utf8_get_char_safe_index); \
    UTF8_NEXT_CHAR_SAFE(s, _utf8_get_char_safe_index, length, c, strict); \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U8_NEXT_UNSAFE, see utf_old.h. */
#define UTF8_NEXT_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[(i)++]; \
    if((uint8_t)((c)-0xc0)<0x35) { \
        uint8_t __count=UTF8_COUNT_TRAIL_BYTES(c); \
        UTF8_MASK_LEAD_BYTE(c, __count); \
        switch(__count) { \
        /* each following branch falls through to the next one */ \
        case 3: \
            (c)=((c)<<6)|((s)[(i)++]&0x3f); \
            U_FALLTHROUGH; \
        case 2: \
            (c)=((c)<<6)|((s)[(i)++]&0x3f); \
            U_FALLTHROUGH; \
        case 1: \
            (c)=((c)<<6)|((s)[(i)++]&0x3f); \
        /* no other branches to optimize switch() */ \
            break; \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U8_APPEND_UNSAFE, see utf_old.h. */
#define UTF8_APPEND_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    if((uint32_t)(c)<=0x7f) { \
        (s)[(i)++]=(uint8_t)(c); \
    } else { \
        if((uint32_t)(c)<=0x7ff) { \
            (s)[(i)++]=(uint8_t)(((c)>>6)|0xc0); \
        } else { \
            if((uint32_t)(c)<=0xffff) { \
                (s)[(i)++]=(uint8_t)(((c)>>12)|0xe0); \
            } else { \
                (s)[(i)++]=(uint8_t)(((c)>>18)|0xf0); \
                (s)[(i)++]=(uint8_t)((((c)>>12)&0x3f)|0x80); \
            } \
            (s)[(i)++]=(uint8_t)((((c)>>6)&0x3f)|0x80); \
        } \
        (s)[(i)++]=(uint8_t)(((c)&0x3f)|0x80); \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U8_FWD_1_UNSAFE, see utf_old.h. */
#define UTF8_FWD_1_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    (i)+=1+UTF8_COUNT_TRAIL_BYTES((s)[i]); \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U8_FWD_N_UNSAFE, see utf_old.h. */
#define UTF8_FWD_N_UNSAFE(s, i, n) UPRV_BLOCK_MACRO_BEGIN { \
    int32_t __N=(n); \
    while(__N>0) { \
        UTF8_FWD_1_UNSAFE(s, i); \
        --__N; \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U8_SET_CP_START_UNSAFE, see utf_old.h. */
#define UTF8_SET_CHAR_START_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    while(UTF8_IS_TRAIL((s)[i])) { --(i); } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Use U8_NEXT instead, see utf_old.h. */
#define UTF8_NEXT_CHAR_SAFE(s, i, length, c, strict) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[(i)++]; \
    if((c)>=0x80) { \
        if(UTF8_IS_LEAD(c)) { \
            (c)=utf8_nextCharSafeBody(s, &(i), (int32_t)(length), c, strict); \
        } else { \
            (c)=UTF8_ERROR_VALUE_1; \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Use U8_APPEND instead, see utf_old.h. */
#define UTF8_APPEND_CHAR_SAFE(s, i, length, c)  UPRV_BLOCK_MACRO_BEGIN { \
    if((uint32_t)(c)<=0x7f) { \
        (s)[(i)++]=(uint8_t)(c); \
    } else { \
        (i)=utf8_appendCharSafeBody(s, (int32_t)(i), (int32_t)(length), c, NULL); \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U8_FWD_1, see utf_old.h. */
#define UTF8_FWD_1_SAFE(s, i, length) U8_FWD_1(s, i, length)

/** @deprecated ICU 2.4. Renamed to U8_FWD_N, see utf_old.h. */
#define UTF8_FWD_N_SAFE(s, i, length, n) U8_FWD_N(s, i, length, n)

/** @deprecated ICU 2.4. Renamed to U8_SET_CP_START, see utf_old.h. */
#define UTF8_SET_CHAR_START_SAFE(s, start, i) U8_SET_CP_START(s, start, i)

/** @deprecated ICU 2.4. Renamed to U8_PREV_UNSAFE, see utf_old.h. */
#define UTF8_PREV_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[--(i)]; \
    if(UTF8_IS_TRAIL(c)) { \
        uint8_t __b, __count=1, __shift=6; \
\
        /* c is a trail byte */ \
        (c)&=0x3f; \
        for(;;) { \
            __b=(s)[--(i)]; \
            if(__b>=0xc0) { \
                UTF8_MASK_LEAD_BYTE(__b, __count); \
                (c)|=(UChar32)__b<<__shift; \
                break; \
            } else { \
                (c)|=(UChar32)(__b&0x3f)<<__shift; \
                ++__count; \
                __shift+=6; \
            } \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U8_BACK_1_UNSAFE, see utf_old.h. */
#define UTF8_BACK_1_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    while(UTF8_IS_TRAIL((s)[--(i)])) {} \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U8_BACK_N_UNSAFE, see utf_old.h. */
#define UTF8_BACK_N_UNSAFE(s, i, n) UPRV_BLOCK_MACRO_BEGIN { \
    int32_t __N=(n); \
    while(__N>0) { \
        UTF8_BACK_1_UNSAFE(s, i); \
        --__N; \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U8_SET_CP_LIMIT_UNSAFE, see utf_old.h. */
#define UTF8_SET_CHAR_LIMIT_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    UTF8_BACK_1_UNSAFE(s, i); \
    UTF8_FWD_1_UNSAFE(s, i); \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Use U8_PREV instead, see utf_old.h. */
#define UTF8_PREV_CHAR_SAFE(s, start, i, c, strict) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[--(i)]; \
    if((c)>=0x80) { \
        if((c)<=0xbf) { \
            (c)=utf8_prevCharSafeBody(s, start, &(i), c, strict); \
        } else { \
            (c)=UTF8_ERROR_VALUE_1; \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U8_BACK_1, see utf_old.h. */
#define UTF8_BACK_1_SAFE(s, start, i) U8_BACK_1(s, start, i)

/** @deprecated ICU 2.4. Renamed to U8_BACK_N, see utf_old.h. */
#define UTF8_BACK_N_SAFE(s, start, i, n) U8_BACK_N(s, start, i, n)

/** @deprecated ICU 2.4. Renamed to U8_SET_CP_LIMIT, see utf_old.h. */
#define UTF8_SET_CHAR_LIMIT_SAFE(s, start, i, length) U8_SET_CP_LIMIT(s, start, i, length)

/* Formerly utf16.h --------------------------------------------------------- */

/** Is uchar a first/lead surrogate? @deprecated ICU 2.4. Renamed to U_IS_LEAD and U16_IS_LEAD, see utf_old.h. */
#define UTF_IS_FIRST_SURROGATE(uchar) (((uchar)&0xfffffc00)==0xd800)

/** Is uchar a second/trail surrogate? @deprecated ICU 2.4. Renamed to U_IS_TRAIL and U16_IS_TRAIL, see utf_old.h. */
#define UTF_IS_SECOND_SURROGATE(uchar) (((uchar)&0xfffffc00)==0xdc00)

/** Assuming c is a surrogate, is it a first/lead surrogate? @deprecated ICU 2.4. Renamed to U_IS_SURROGATE_LEAD and U16_IS_SURROGATE_LEAD, see utf_old.h. */
#define UTF_IS_SURROGATE_FIRST(c) (((c)&0x400)==0)

/** Helper constant for UTF16_GET_PAIR_VALUE. @deprecated ICU 2.4. Renamed to U16_SURROGATE_OFFSET, see utf_old.h. */
#define UTF_SURROGATE_OFFSET ((0xd800<<10UL)+0xdc00-0x10000)

/** Get the UTF-32 value from the surrogate code units. @deprecated ICU 2.4. Renamed to U16_GET_SUPPLEMENTARY, see utf_old.h. */
#define UTF16_GET_PAIR_VALUE(first, second) \
    (((first)<<10UL)+(second)-UTF_SURROGATE_OFFSET)

/** @deprecated ICU 2.4. Renamed to U16_LEAD, see utf_old.h. */
#define UTF_FIRST_SURROGATE(supplementary) (UChar)(((supplementary)>>10)+0xd7c0)

/** @deprecated ICU 2.4. Renamed to U16_TRAIL, see utf_old.h. */
#define UTF_SECOND_SURROGATE(supplementary) (UChar)(((supplementary)&0x3ff)|0xdc00)

/** @deprecated ICU 2.4. Renamed to U16_LEAD, see utf_old.h. */
#define UTF16_LEAD(supplementary) UTF_FIRST_SURROGATE(supplementary)

/** @deprecated ICU 2.4. Renamed to U16_TRAIL, see utf_old.h. */
#define UTF16_TRAIL(supplementary) UTF_SECOND_SURROGATE(supplementary)

/** @deprecated ICU 2.4. Renamed to U16_IS_SINGLE, see utf_old.h. */
#define UTF16_IS_SINGLE(uchar) !UTF_IS_SURROGATE(uchar)

/** @deprecated ICU 2.4. Renamed to U16_IS_LEAD, see utf_old.h. */
#define UTF16_IS_LEAD(uchar) UTF_IS_FIRST_SURROGATE(uchar)

/** @deprecated ICU 2.4. Renamed to U16_IS_TRAIL, see utf_old.h. */
#define UTF16_IS_TRAIL(uchar) UTF_IS_SECOND_SURROGATE(uchar)

/** Does this scalar Unicode value need multiple code units for storage? @deprecated ICU 2.4. Use U16_LENGTH or test ((uint32_t)(c)>0xffff) instead, see utf_old.h. */
#define UTF16_NEED_MULTIPLE_UCHAR(c) ((uint32_t)(c)>0xffff)

/** @deprecated ICU 2.4. Renamed to U16_LENGTH, see utf_old.h. */
#define UTF16_CHAR_LENGTH(c) ((uint32_t)(c)<=0xffff ? 1 : 2)

/** @deprecated ICU 2.4. Renamed to U16_MAX_LENGTH, see utf_old.h. */
#define UTF16_MAX_CHAR_LENGTH 2

/** Average number of code units compared to UTF-16. @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF16_ARRAY_SIZE(size) (size)

/**
 * Get a single code point from an offset that points to any
 * of the code units that belong to that code point.
 * Assume 0<=i<length.
 *
 * This could be used for iteration together with
 * UTF16_CHAR_LENGTH() and UTF_IS_ERROR(),
 * but the use of UTF16_NEXT_CHAR[_UNSAFE]() and
 * UTF16_PREV_CHAR[_UNSAFE]() is more efficient for that.
 * @deprecated ICU 2.4. Renamed to U16_GET_UNSAFE, see utf_old.h.
 */
#define UTF16_GET_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[i]; \
    if(UTF_IS_SURROGATE(c)) { \
        if(UTF_IS_SURROGATE_FIRST(c)) { \
            (c)=UTF16_GET_PAIR_VALUE((c), (s)[(i)+1]); \
        } else { \
            (c)=UTF16_GET_PAIR_VALUE((s)[(i)-1], (c)); \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Use U16_GET instead, see utf_old.h. */
#define UTF16_GET_CHAR_SAFE(s, start, i, length, c, strict) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[i]; \
    if(UTF_IS_SURROGATE(c)) { \
        uint16_t __c2; \
        if(UTF_IS_SURROGATE_FIRST(c)) { \
            if((i)+1<(length) && UTF_IS_SECOND_SURROGATE(__c2=(s)[(i)+1])) { \
                (c)=UTF16_GET_PAIR_VALUE((c), __c2); \
                /* strict: ((c)&0xfffe)==0xfffe is caught by UTF_IS_ERROR() and UTF_IS_UNICODE_CHAR() */ \
            } else if(strict) {\
                /* unmatched first surrogate */ \
                (c)=UTF_ERROR_VALUE; \
            } \
        } else { \
            if((i)-1>=(start) && UTF_IS_FIRST_SURROGATE(__c2=(s)[(i)-1])) { \
                (c)=UTF16_GET_PAIR_VALUE(__c2, (c)); \
                /* strict: ((c)&0xfffe)==0xfffe is caught by UTF_IS_ERROR() and UTF_IS_UNICODE_CHAR() */ \
            } else if(strict) {\
                /* unmatched second surrogate */ \
                (c)=UTF_ERROR_VALUE; \
            } \
        } \
    } else if((strict) && !UTF_IS_UNICODE_CHAR(c)) { \
        (c)=UTF_ERROR_VALUE; \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U16_NEXT_UNSAFE, see utf_old.h. */
#define UTF16_NEXT_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[(i)++]; \
    if(UTF_IS_FIRST_SURROGATE(c)) { \
        (c)=UTF16_GET_PAIR_VALUE((c), (s)[(i)++]); \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U16_APPEND_UNSAFE, see utf_old.h. */
#define UTF16_APPEND_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    if((uint32_t)(c)<=0xffff) { \
        (s)[(i)++]=(uint16_t)(c); \
    } else { \
        (s)[(i)++]=(uint16_t)(((c)>>10)+0xd7c0); \
        (s)[(i)++]=(uint16_t)(((c)&0x3ff)|0xdc00); \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U16_FWD_1_UNSAFE, see utf_old.h. */
#define UTF16_FWD_1_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    if(UTF_IS_FIRST_SURROGATE((s)[(i)++])) { \
        ++(i); \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U16_FWD_N_UNSAFE, see utf_old.h. */
#define UTF16_FWD_N_UNSAFE(s, i, n) UPRV_BLOCK_MACRO_BEGIN { \
    int32_t __N=(n); \
    while(__N>0) { \
        UTF16_FWD_1_UNSAFE(s, i); \
        --__N; \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U16_SET_CP_START_UNSAFE, see utf_old.h. */
#define UTF16_SET_CHAR_START_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    if(UTF_IS_SECOND_SURROGATE((s)[i])) { \
        --(i); \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Use U16_NEXT instead, see utf_old.h. */
#define UTF16_NEXT_CHAR_SAFE(s, i, length, c, strict) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[(i)++]; \
    if(UTF_IS_FIRST_SURROGATE(c)) { \
        uint16_t __c2; \
        if((i)<(length) && UTF_IS_SECOND_SURROGATE(__c2=(s)[(i)])) { \
            ++(i); \
            (c)=UTF16_GET_PAIR_VALUE((c), __c2); \
            /* strict: ((c)&0xfffe)==0xfffe is caught by UTF_IS_ERROR() and UTF_IS_UNICODE_CHAR() */ \
        } else if(strict) {\
            /* unmatched first surrogate */ \
            (c)=UTF_ERROR_VALUE; \
        } \
    } else if((strict) && !UTF_IS_UNICODE_CHAR(c)) { \
        /* unmatched second surrogate or other non-character */ \
        (c)=UTF_ERROR_VALUE; \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Use U16_APPEND instead, see utf_old.h. */
#define UTF16_APPEND_CHAR_SAFE(s, i, length, c) UPRV_BLOCK_MACRO_BEGIN { \
    if((uint32_t)(c)<=0xffff) { \
        (s)[(i)++]=(uint16_t)(c); \
    } else if((uint32_t)(c)<=0x10ffff) { \
        if((i)+1<(length)) { \
            (s)[(i)++]=(uint16_t)(((c)>>10)+0xd7c0); \
            (s)[(i)++]=(uint16_t)(((c)&0x3ff)|0xdc00); \
        } else /* not enough space */ { \
            (s)[(i)++]=UTF_ERROR_VALUE; \
        } \
    } else /* c>0x10ffff, write error value */ { \
        (s)[(i)++]=UTF_ERROR_VALUE; \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U16_FWD_1, see utf_old.h. */
#define UTF16_FWD_1_SAFE(s, i, length) U16_FWD_1(s, i, length)

/** @deprecated ICU 2.4. Renamed to U16_FWD_N, see utf_old.h. */
#define UTF16_FWD_N_SAFE(s, i, length, n) U16_FWD_N(s, i, length, n)

/** @deprecated ICU 2.4. Renamed to U16_SET_CP_START, see utf_old.h. */
#define UTF16_SET_CHAR_START_SAFE(s, start, i) U16_SET_CP_START(s, start, i)

/** @deprecated ICU 2.4. Renamed to U16_PREV_UNSAFE, see utf_old.h. */
#define UTF16_PREV_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[--(i)]; \
    if(UTF_IS_SECOND_SURROGATE(c)) { \
        (c)=UTF16_GET_PAIR_VALUE((s)[--(i)], (c)); \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U16_BACK_1_UNSAFE, see utf_old.h. */
#define UTF16_BACK_1_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    if(UTF_IS_SECOND_SURROGATE((s)[--(i)])) { \
        --(i); \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U16_BACK_N_UNSAFE, see utf_old.h. */
#define UTF16_BACK_N_UNSAFE(s, i, n) UPRV_BLOCK_MACRO_BEGIN { \
    int32_t __N=(n); \
    while(__N>0) { \
        UTF16_BACK_1_UNSAFE(s, i); \
        --__N; \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U16_SET_CP_LIMIT_UNSAFE, see utf_old.h. */
#define UTF16_SET_CHAR_LIMIT_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    if(UTF_IS_FIRST_SURROGATE((s)[(i)-1])) { \
        ++(i); \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Use U16_PREV instead, see utf_old.h. */
#define UTF16_PREV_CHAR_SAFE(s, start, i, c, strict) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[--(i)]; \
    if(UTF_IS_SECOND_SURROGATE(c)) { \
        uint16_t __c2; \
        if((i)>(start) && UTF_IS_FIRST_SURROGATE(__c2=(s)[(i)-1])) { \
            --(i); \
            (c)=UTF16_GET_PAIR_VALUE(__c2, (c)); \
            /* strict: ((c)&0xfffe)==0xfffe is caught by UTF_IS_ERROR() and UTF_IS_UNICODE_CHAR() */ \
        } else if(strict) {\
            /* unmatched second surrogate */ \
            (c)=UTF_ERROR_VALUE; \
        } \
    } else if((strict) && !UTF_IS_UNICODE_CHAR(c)) { \
        /* unmatched first surrogate or other non-character */ \
        (c)=UTF_ERROR_VALUE; \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Renamed to U16_BACK_1, see utf_old.h. */
#define UTF16_BACK_1_SAFE(s, start, i) U16_BACK_1(s, start, i)

/** @deprecated ICU 2.4. Renamed to U16_BACK_N, see utf_old.h. */
#define UTF16_BACK_N_SAFE(s, start, i, n) U16_BACK_N(s, start, i, n)

/** @deprecated ICU 2.4. Renamed to U16_SET_CP_LIMIT, see utf_old.h. */
#define UTF16_SET_CHAR_LIMIT_SAFE(s, start, i, length) U16_SET_CP_LIMIT(s, start, i, length)

/* Formerly utf32.h --------------------------------------------------------- */

/*
* Old documentation:
*
*   This file defines macros to deal with UTF-32 code units and code points.
*   Signatures and semantics are the same as for the similarly named macros
*   in utf16.h.
*   utf32.h is included by utf.h after unicode/umachine.h</p>
*   and some common definitions.
*   <p><b>Usage:</b>  ICU coding guidelines for if() statements should be followed when using these macros.
*                  Compound statements (curly braces {}) must be used  for if-else-while...
*                  bodies and all macro statements should be terminated with semicolon.</p>
*/

/* internal definitions ----------------------------------------------------- */

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_IS_SAFE(c, strict) \
    (!(strict) ? \
        (uint32_t)(c)<=0x10ffff : \
        UTF_IS_UNICODE_CHAR(c))

/*
 * For the semantics of all of these macros, see utf16.h.
 * The UTF-32 versions are trivial because any code point is
 * encoded using exactly one code unit.
 */

/* single-code point definitions -------------------------------------------- */

/* classes of code unit values */

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_IS_SINGLE(uchar) 1
/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_IS_LEAD(uchar) 0
/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_IS_TRAIL(uchar) 0

/* number of code units per code point */

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_NEED_MULTIPLE_UCHAR(c) 0
/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_CHAR_LENGTH(c) 1
/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_MAX_CHAR_LENGTH 1

/* average number of code units compared to UTF-16 */

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_ARRAY_SIZE(size) (size)

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_GET_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[i]; \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_GET_CHAR_SAFE(s, start, i, length, c, strict) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[i]; \
    if(!UTF32_IS_SAFE(c, strict)) { \
        (c)=UTF_ERROR_VALUE; \
    } \
} UPRV_BLOCK_MACRO_END

/* definitions with forward iteration --------------------------------------- */

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_NEXT_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[(i)++]; \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_APPEND_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (s)[(i)++]=(c); \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_FWD_1_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    ++(i); \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_FWD_N_UNSAFE(s, i, n) UPRV_BLOCK_MACRO_BEGIN { \
    (i)+=(n); \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_SET_CHAR_START_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_NEXT_CHAR_SAFE(s, i, length, c, strict) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[(i)++]; \
    if(!UTF32_IS_SAFE(c, strict)) { \
        (c)=UTF_ERROR_VALUE; \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_APPEND_CHAR_SAFE(s, i, length, c) UPRV_BLOCK_MACRO_BEGIN { \
    if((uint32_t)(c)<=0x10ffff) { \
        (s)[(i)++]=(c); \
    } else /* c>0x10ffff, write 0xfffd */ { \
        (s)[(i)++]=0xfffd; \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_FWD_1_SAFE(s, i, length) UPRV_BLOCK_MACRO_BEGIN { \
    ++(i); \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_FWD_N_SAFE(s, i, length, n) UPRV_BLOCK_MACRO_BEGIN { \
    if(((i)+=(n))>(length)) { \
        (i)=(length); \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_SET_CHAR_START_SAFE(s, start, i) UPRV_BLOCK_MACRO_BEGIN { \
} UPRV_BLOCK_MACRO_END

/* definitions with backward iteration -------------------------------------- */

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_PREV_CHAR_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[--(i)]; \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_BACK_1_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    --(i); \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_BACK_N_UNSAFE(s, i, n) UPRV_BLOCK_MACRO_BEGIN { \
    (i)-=(n); \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_SET_CHAR_LIMIT_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_PREV_CHAR_SAFE(s, start, i, c, strict) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[--(i)]; \
    if(!UTF32_IS_SAFE(c, strict)) { \
        (c)=UTF_ERROR_VALUE; \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_BACK_1_SAFE(s, start, i) UPRV_BLOCK_MACRO_BEGIN { \
    --(i); \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_BACK_N_SAFE(s, start, i, n) UPRV_BLOCK_MACRO_BEGIN { \
    (i)-=(n); \
    if((i)<(start)) { \
        (i)=(start); \
    } \
} UPRV_BLOCK_MACRO_END

/** @deprecated ICU 2.4. Obsolete, see utf_old.h. */
#define UTF32_SET_CHAR_LIMIT_SAFE(s, i, length) UPRV_BLOCK_MACRO_BEGIN { \
} UPRV_BLOCK_MACRO_END

/* Formerly utf.h, part 2 --------------------------------------------------- */

/**
 * Estimate the number of code units for a string based on the number of UTF-16 code units.
 *
 * @deprecated ICU 2.4. Obsolete, see utf_old.h.
 */
#define UTF_ARRAY_SIZE(size) UTF16_ARRAY_SIZE(size)

/** @deprecated ICU 2.4. Renamed to U16_GET_UNSAFE, see utf_old.h. */
#define UTF_GET_CHAR_UNSAFE(s, i, c)                 UTF16_GET_CHAR_UNSAFE(s, i, c)

/** @deprecated ICU 2.4. Use U16_GET instead, see utf_old.h. */
#define UTF_GET_CHAR_SAFE(s, start, i, length, c, strict) UTF16_GET_CHAR_SAFE(s, start, i, length, c, strict)


/** @deprecated ICU 2.4. Renamed to U16_NEXT_UNSAFE, see utf_old.h. */
#define UTF_NEXT_CHAR_UNSAFE(s, i, c)                UTF16_NEXT_CHAR_UNSAFE(s, i, c)

/** @deprecated ICU 2.4. Use U16_NEXT instead, see utf_old.h. */
#define UTF_NEXT_CHAR_SAFE(s, i, length, c, strict)  UTF16_NEXT_CHAR_SAFE(s, i, length, c, strict)


/** @deprecated ICU 2.4. Renamed to U16_APPEND_UNSAFE, see utf_old.h. */
#define UTF_APPEND_CHAR_UNSAFE(s, i, c)              UTF16_APPEND_CHAR_UNSAFE(s, i, c)

/** @deprecated ICU 2.4. Use U16_APPEND instead, see utf_old.h. */
#define UTF_APPEND_CHAR_SAFE(s, i, length, c)        UTF16_APPEND_CHAR_SAFE(s, i, length, c)


/** @deprecated ICU 2.4. Renamed to U16_FWD_1_UNSAFE, see utf_old.h. */
#define UTF_FWD_1_UNSAFE(s, i)                       UTF16_FWD_1_UNSAFE(s, i)

/** @deprecated ICU 2.4. Renamed to U16_FWD_1, see utf_old.h. */
#define UTF_FWD_1_SAFE(s, i, length)                 UTF16_FWD_1_SAFE(s, i, length)


/** @deprecated ICU 2.4. Renamed to U16_FWD_N_UNSAFE, see utf_old.h. */
#define UTF_FWD_N_UNSAFE(s, i, n)                    UTF16_FWD_N_UNSAFE(s, i, n)

/** @deprecated ICU 2.4. Renamed to U16_FWD_N, see utf_old.h. */
#define UTF_FWD_N_SAFE(s, i, length, n)              UTF16_FWD_N_SAFE(s, i, length, n)


/** @deprecated ICU 2.4. Renamed to U16_SET_CP_START_UNSAFE, see utf_old.h. */
#define UTF_SET_CHAR_START_UNSAFE(s, i)              UTF16_SET_CHAR_START_UNSAFE(s, i)

/** @deprecated ICU 2.4. Renamed to U16_SET_CP_START, see utf_old.h. */
#define UTF_SET_CHAR_START_SAFE(s, start, i)         UTF16_SET_CHAR_START_SAFE(s, start, i)


/** @deprecated ICU 2.4. Renamed to U16_PREV_UNSAFE, see utf_old.h. */
#define UTF_PREV_CHAR_UNSAFE(s, i, c)                UTF16_PREV_CHAR_UNSAFE(s, i, c)

/** @deprecated ICU 2.4. Use U16_PREV instead, see utf_old.h. */
#define UTF_PREV_CHAR_SAFE(s, start, i, c, strict)   UTF16_PREV_CHAR_SAFE(s, start, i, c, strict)


/** @deprecated ICU 2.4. Renamed to U16_BACK_1_UNSAFE, see utf_old.h. */
#define UTF_BACK_1_UNSAFE(s, i)                      UTF16_BACK_1_UNSAFE(s, i)

/** @deprecated ICU 2.4. Renamed to U16_BACK_1, see utf_old.h. */
#define UTF_BACK_1_SAFE(s, start, i)                 UTF16_BACK_1_SAFE(s, start, i)


/** @deprecated ICU 2.4. Renamed to U16_BACK_N_UNSAFE, see utf_old.h. */
#define UTF_BACK_N_UNSAFE(s, i, n)                   UTF16_BACK_N_UNSAFE(s, i, n)

/** @deprecated ICU 2.4. Renamed to U16_BACK_N, see utf_old.h. */
#define UTF_BACK_N_SAFE(s, start, i, n)              UTF16_BACK_N_SAFE(s, start, i, n)


/** @deprecated ICU 2.4. Renamed to U16_SET_CP_LIMIT_UNSAFE, see utf_old.h. */
#define UTF_SET_CHAR_LIMIT_UNSAFE(s, i)              UTF16_SET_CHAR_LIMIT_UNSAFE(s, i)

/** @deprecated ICU 2.4. Renamed to U16_SET_CP_LIMIT, see utf_old.h. */
#define UTF_SET_CHAR_LIMIT_SAFE(s, start, i, length) UTF16_SET_CHAR_LIMIT_SAFE(s, start, i, length)

/* Define default macros (UTF-16 "safe") ------------------------------------ */

/**
 * Does this code unit alone encode a code point (BMP, not a surrogate)?
 * Same as UTF16_IS_SINGLE.
 * @deprecated ICU 2.4. Renamed to U_IS_SINGLE and U16_IS_SINGLE, see utf_old.h.
 */
#define UTF_IS_SINGLE(uchar) U16_IS_SINGLE(uchar)

/**
 * Is this code unit the first one of several (a lead surrogate)?
 * Same as UTF16_IS_LEAD.
 * @deprecated ICU 2.4. Renamed to U_IS_LEAD and U16_IS_LEAD, see utf_old.h.
 */
#define UTF_IS_LEAD(uchar) U16_IS_LEAD(uchar)

/**
 * Is this code unit one of several but not the first one (a trail surrogate)?
 * Same as UTF16_IS_TRAIL.
 * @deprecated ICU 2.4. Renamed to U_IS_TRAIL and U16_IS_TRAIL, see utf_old.h.
 */
#define UTF_IS_TRAIL(uchar) U16_IS_TRAIL(uchar)

/**
 * Does this code point require multiple code units (is it a supplementary code point)?
 * Same as UTF16_NEED_MULTIPLE_UCHAR.
 * @deprecated ICU 2.4. Use U16_LENGTH or test ((uint32_t)(c)>0xffff) instead.
 */
#define UTF_NEED_MULTIPLE_UCHAR(c) UTF16_NEED_MULTIPLE_UCHAR(c)

/**
 * How many code units are used to encode this code point (1 or 2)?
 * Same as UTF16_CHAR_LENGTH.
 * @deprecated ICU 2.4. Renamed to U16_LENGTH, see utf_old.h.
 */
#define UTF_CHAR_LENGTH(c) U16_LENGTH(c)

/**
 * How many code units are used at most for any Unicode code point (2)?
 * Same as UTF16_MAX_CHAR_LENGTH.
 * @deprecated ICU 2.4. Renamed to U16_MAX_LENGTH, see utf_old.h.
 */
#define UTF_MAX_CHAR_LENGTH U16_MAX_LENGTH

/**
 * Set c to the code point that contains the code unit i.
 * i could point to the lead or the trail surrogate for the code point.
 * i is not modified.
 * Same as UTF16_GET_CHAR.
 * \pre 0<=i<length
 *
 * @deprecated ICU 2.4. Renamed to U16_GET, see utf_old.h.
 */
#define UTF_GET_CHAR(s, start, i, length, c) U16_GET(s, start, i, length, c)

/**
 * Set c to the code point that starts at code unit i
 * and advance i to beyond the code units of this code point (post-increment).
 * i must point to the first code unit of a code point.
 * Otherwise c is set to the trail unit (surrogate) itself.
 * Same as UTF16_NEXT_CHAR.
 * \pre 0<=i<length
 * \post 0<i<=length
 *
 * @deprecated ICU 2.4. Renamed to U16_NEXT, see utf_old.h.
 */
#define UTF_NEXT_CHAR(s, i, length, c) U16_NEXT(s, i, length, c)

/**
 * Append the code units of code point c to the string at index i
 * and advance i to beyond the new code units (post-increment).
 * The code units beginning at index i will be overwritten.
 * Same as UTF16_APPEND_CHAR.
 * \pre 0<=c<=0x10ffff
 * \pre 0<=i<length
 * \post 0<i<=length
 *
 * @deprecated ICU 2.4. Use U16_APPEND instead, see utf_old.h.
 */
#define UTF_APPEND_CHAR(s, i, length, c) UTF16_APPEND_CHAR_SAFE(s, i, length, c)

/**
 * Advance i to beyond the code units of the code point that begins at i.
 * I.e., advance i by one code point.
 * Same as UTF16_FWD_1.
 * \pre 0<=i<length
 * \post 0<i<=length
 *
 * @deprecated ICU 2.4. Renamed to U16_FWD_1, see utf_old.h.
 */
#define UTF_FWD_1(s, i, length) U16_FWD_1(s, i, length)

/**
 * Advance i to beyond the code units of the n code points where the first one begins at i.
 * I.e., advance i by n code points.
 * Same as UT16_FWD_N.
 * \pre 0<=i<length
 * \post 0<i<=length
 *
 * @deprecated ICU 2.4. Renamed to U16_FWD_N, see utf_old.h.
 */
#define UTF_FWD_N(s, i, length, n) U16_FWD_N(s, i, length, n)

/**
 * Take the random-access index i and adjust it so that it points to the beginning
 * of a code point.
 * The input index points to any code unit of a code point and is moved to point to
 * the first code unit of the same code point. i is never incremented.
 * In other words, if i points to a trail surrogate that is preceded by a matching
 * lead surrogate, then i is decremented. Otherwise it is not modified.
 * This can be used to start an iteration with UTF_NEXT_CHAR() from a random index.
 * Same as UTF16_SET_CHAR_START.
 * \pre start<=i<length
 * \post start<=i<length
 *
 * @deprecated ICU 2.4. Renamed to U16_SET_CP_START, see utf_old.h.
 */
#define UTF_SET_CHAR_START(s, start, i) U16_SET_CP_START(s, start, i)

/**
 * Set c to the code point that has code units before i
 * and move i backward (towards the beginning of the string)
 * to the first code unit of this code point (pre-increment).
 * i must point to the first code unit after the last unit of a code point (i==length is allowed).
 * Same as UTF16_PREV_CHAR.
 * \pre start<i<=length
 * \post start<=i<length
 *
 * @deprecated ICU 2.4. Renamed to U16_PREV, see utf_old.h.
 */
#define UTF_PREV_CHAR(s, start, i, c) U16_PREV(s, start, i, c)

/**
 * Move i backward (towards the beginning of the string)
 * to the first code unit of the code point that has code units before i.
 * I.e., move i backward by one code point.
 * i must point to the first code unit after the last unit of a code point (i==length is allowed).
 * Same as UTF16_BACK_1.
 * \pre start<i<=length
 * \post start<=i<length
 *
 * @deprecated ICU 2.4. Renamed to U16_BACK_1, see utf_old.h.
 */
#define UTF_BACK_1(s, start, i) U16_BACK_1(s, start, i)

/**
 * Move i backward (towards the beginning of the string)
 * to the first code unit of the n code points that have code units before i.
 * I.e., move i backward by n code points.
 * i must point to the first code unit after the last unit of a code point (i==length is allowed).
 * Same as UTF16_BACK_N.
 * \pre start<i<=length
 * \post start<=i<length
 *
 * @deprecated ICU 2.4. Renamed to U16_BACK_N, see utf_old.h.
 */
#define UTF_BACK_N(s, start, i, n) U16_BACK_N(s, start, i, n)

/**
 * Take the random-access index i and adjust it so that it points beyond
 * a code point. The input index points beyond any code unit
 * of a code point and is moved to point beyond the last code unit of the same
 * code point. i is never decremented.
 * In other words, if i points to a trail surrogate that is preceded by a matching
 * lead surrogate, then i is incremented. Otherwise it is not modified.
 * This can be used to start an iteration with UTF_PREV_CHAR() from a random index.
 * Same as UTF16_SET_CHAR_LIMIT.
 * \pre start<i<=length
 * \post start<i<=length
 *
 * @deprecated ICU 2.4. Renamed to U16_SET_CP_LIMIT, see utf_old.h.
 */
#define UTF_SET_CHAR_LIMIT(s, start, i, length) U16_SET_CP_LIMIT(s, start, i, length)

#endif  // !U_HIDE_DEPRECATED_API && !U_HIDE_OBSOLETE_UTF_OLD_H

#endif
