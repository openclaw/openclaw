// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*
*   Copyright (C) 1999-2012, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
*******************************************************************************
*   file name:  utf16.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 1999sep09
*   created by: Markus W. Scherer
*/

/**
 * \file
 * \brief C API: 16-bit Unicode handling macros
 * 
 * This file defines macros to deal with 16-bit Unicode (UTF-16) code units and strings.
 *
 * For more information see utf.h and the ICU User Guide Strings chapter
 * (https://unicode-org.github.io/icu/userguide/strings).
 *
 * <em>Usage:</em>
 * ICU coding guidelines for if() statements should be followed when using these macros.
 * Compound statements (curly braces {}) must be used  for if-else-while... 
 * bodies and all macro statements should be terminated with semicolon.
 */

#ifndef __UTF16_H__
#define __UTF16_H__

#include <stdbool.h>
#include "unicode/umachine.h"
#ifndef __UTF_H__
#   include "unicode/utf.h"
#endif

/* single-code point definitions -------------------------------------------- */

/**
 * Does this code unit alone encode a code point (BMP, not a surrogate)?
 * @param c 16-bit code unit
 * @return true or false
 * @stable ICU 2.4
 */
#define U16_IS_SINGLE(c) !U_IS_SURROGATE(c)

/**
 * Is this code unit a lead surrogate (U+d800..U+dbff)?
 * @param c 16-bit code unit
 * @return true or false
 * @stable ICU 2.4
 */
#define U16_IS_LEAD(c) (((c)&0xfffffc00)==0xd800)

/**
 * Is this code unit a trail surrogate (U+dc00..U+dfff)?
 * @param c 16-bit code unit
 * @return true or false
 * @stable ICU 2.4
 */
#define U16_IS_TRAIL(c) (((c)&0xfffffc00)==0xdc00)

/**
 * Is this code unit a surrogate (U+d800..U+dfff)?
 * @param c 16-bit code unit
 * @return true or false
 * @stable ICU 2.4
 */
#define U16_IS_SURROGATE(c) U_IS_SURROGATE(c)

/**
 * Assuming c is a surrogate code point (U16_IS_SURROGATE(c)),
 * is it a lead surrogate?
 * @param c 16-bit code unit
 * @return true or false
 * @stable ICU 2.4
 */
#define U16_IS_SURROGATE_LEAD(c) (((c)&0x400)==0)

/**
 * Assuming c is a surrogate code point (U16_IS_SURROGATE(c)),
 * is it a trail surrogate?
 * @param c 16-bit code unit
 * @return true or false
 * @stable ICU 4.2
 */
#define U16_IS_SURROGATE_TRAIL(c) (((c)&0x400)!=0)

/**
 * Helper constant for U16_GET_SUPPLEMENTARY.
 * @internal
 */
#define U16_SURROGATE_OFFSET ((0xd800<<10UL)+0xdc00-0x10000)

/**
 * Get a supplementary code point value (U+10000..U+10ffff)
 * from its lead and trail surrogates.
 * The result is undefined if the input values are not
 * lead and trail surrogates.
 *
 * @param lead lead surrogate (U+d800..U+dbff)
 * @param trail trail surrogate (U+dc00..U+dfff)
 * @return supplementary code point (U+10000..U+10ffff)
 * @stable ICU 2.4
 */
#define U16_GET_SUPPLEMENTARY(lead, trail) \
    (((UChar32)(lead)<<10UL)+(UChar32)(trail)-U16_SURROGATE_OFFSET)


/**
 * Get the lead surrogate (0xd800..0xdbff) for a
 * supplementary code point (0x10000..0x10ffff).
 * @param supplementary 32-bit code point (U+10000..U+10ffff)
 * @return lead surrogate (U+d800..U+dbff) for supplementary
 * @stable ICU 2.4
 */
#define U16_LEAD(supplementary) (UChar)(((supplementary)>>10)+0xd7c0)

/**
 * Get the trail surrogate (0xdc00..0xdfff) for a
 * supplementary code point (0x10000..0x10ffff).
 * @param supplementary 32-bit code point (U+10000..U+10ffff)
 * @return trail surrogate (U+dc00..U+dfff) for supplementary
 * @stable ICU 2.4
 */
#define U16_TRAIL(supplementary) (UChar)(((supplementary)&0x3ff)|0xdc00)

/**
 * How many 16-bit code units are used to encode this Unicode code point? (1 or 2)
 * The result is not defined if c is not a Unicode code point (U+0000..U+10ffff).
 * @param c 32-bit code point
 * @return 1 or 2
 * @stable ICU 2.4
 */
#define U16_LENGTH(c) ((uint32_t)(c)<=0xffff ? 1 : 2)

/**
 * The maximum number of 16-bit code units per Unicode code point (U+0000..U+10ffff).
 * @return 2
 * @stable ICU 2.4
 */
#define U16_MAX_LENGTH 2

/**
 * Get a code point from a string at a random-access offset,
 * without changing the offset.
 * "Unsafe" macro, assumes well-formed UTF-16.
 *
 * The offset may point to either the lead or trail surrogate unit
 * for a supplementary code point, in which case the macro will read
 * the adjacent matching surrogate as well.
 * The result is undefined if the offset points to a single, unpaired surrogate.
 * Iteration through a string is more efficient with U16_NEXT_UNSAFE or U16_NEXT.
 *
 * @param s const UChar * string
 * @param i string offset
 * @param c output UChar32 variable
 * @see U16_GET
 * @stable ICU 2.4
 */
#define U16_GET_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[i]; \
    if(U16_IS_SURROGATE(c)) { \
        if(U16_IS_SURROGATE_LEAD(c)) { \
            (c)=U16_GET_SUPPLEMENTARY((c), (s)[(i)+1]); \
        } else { \
            (c)=U16_GET_SUPPLEMENTARY((s)[(i)-1], (c)); \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Get a code point from a string at a random-access offset,
 * without changing the offset.
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * The offset may point to either the lead or trail surrogate unit
 * for a supplementary code point, in which case the macro will read
 * the adjacent matching surrogate as well.
 *
 * The length can be negative for a NUL-terminated string.
 *
 * If the offset points to a single, unpaired surrogate, then
 * c is set to that unpaired surrogate.
 * Iteration through a string is more efficient with U16_NEXT_UNSAFE or U16_NEXT.
 *
 * @param s const UChar * string
 * @param start starting string offset (usually 0)
 * @param i string offset, must be start<=i<length
 * @param length string length
 * @param c output UChar32 variable
 * @see U16_GET_UNSAFE
 * @stable ICU 2.4
 */
#define U16_GET(s, start, i, length, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[i]; \
    if(U16_IS_SURROGATE(c)) { \
        uint16_t __c2; \
        if(U16_IS_SURROGATE_LEAD(c)) { \
            if((i)+1!=(length) && U16_IS_TRAIL(__c2=(s)[(i)+1])) { \
                (c)=U16_GET_SUPPLEMENTARY((c), __c2); \
            } \
        } else { \
            if((i)>(start) && U16_IS_LEAD(__c2=(s)[(i)-1])) { \
                (c)=U16_GET_SUPPLEMENTARY(__c2, (c)); \
            } \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Get a code point from a string at a random-access offset,
 * without changing the offset.
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * The offset may point to either the lead or trail surrogate unit
 * for a supplementary code point, in which case the macro will read
 * the adjacent matching surrogate as well.
 *
 * The length can be negative for a NUL-terminated string.
 *
 * If the offset points to a single, unpaired surrogate, then
 * c is set to U+FFFD.
 * Iteration through a string is more efficient with U16_NEXT_UNSAFE or U16_NEXT_OR_FFFD.
 *
 * @param s const UChar * string
 * @param start starting string offset (usually 0)
 * @param i string offset, must be start<=i<length
 * @param length string length
 * @param c output UChar32 variable
 * @see U16_GET_UNSAFE
 * @stable ICU 60
 */
#define U16_GET_OR_FFFD(s, start, i, length, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[i]; \
    if(U16_IS_SURROGATE(c)) { \
        uint16_t __c2; \
        if(U16_IS_SURROGATE_LEAD(c)) { \
            if((i)+1!=(length) && U16_IS_TRAIL(__c2=(s)[(i)+1])) { \
                (c)=U16_GET_SUPPLEMENTARY((c), __c2); \
            } else { \
                (c)=0xfffd; \
            } \
        } else { \
            if((i)>(start) && U16_IS_LEAD(__c2=(s)[(i)-1])) { \
                (c)=U16_GET_SUPPLEMENTARY(__c2, (c)); \
            } else { \
                (c)=0xfffd; \
            } \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/* definitions with forward iteration --------------------------------------- */

/**
 * Get a code point from a string at a code point boundary offset,
 * and advance the offset to the next code point boundary.
 * (Post-incrementing forward iteration.)
 * "Unsafe" macro, assumes well-formed UTF-16.
 *
 * The offset may point to the lead surrogate unit
 * for a supplementary code point, in which case the macro will read
 * the following trail surrogate as well.
 * If the offset points to a trail surrogate, then that itself
 * will be returned as the code point.
 * The result is undefined if the offset points to a single, unpaired lead surrogate.
 *
 * @param s const UChar * string
 * @param i string offset
 * @param c output UChar32 variable
 * @see U16_NEXT
 * @stable ICU 2.4
 */
#define U16_NEXT_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[(i)++]; \
    if(U16_IS_LEAD(c)) { \
        (c)=U16_GET_SUPPLEMENTARY((c), (s)[(i)++]); \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Get a code point from a string at a code point boundary offset,
 * and advance the offset to the next code point boundary.
 * (Post-incrementing forward iteration.)
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * The length can be negative for a NUL-terminated string.
 *
 * The offset may point to the lead surrogate unit
 * for a supplementary code point, in which case the macro will read
 * the following trail surrogate as well.
 * If the offset points to a trail surrogate or
 * to a single, unpaired lead surrogate, then c is set to that unpaired surrogate.
 *
 * @param s const UChar * string
 * @param i string offset, must be i<length
 * @param length string length
 * @param c output UChar32 variable
 * @see U16_NEXT_UNSAFE
 * @stable ICU 2.4
 */
#define U16_NEXT(s, i, length, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[(i)++]; \
    if(U16_IS_LEAD(c)) { \
        uint16_t __c2; \
        if((i)!=(length) && U16_IS_TRAIL(__c2=(s)[(i)])) { \
            ++(i); \
            (c)=U16_GET_SUPPLEMENTARY((c), __c2); \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Get a code point from a string at a code point boundary offset,
 * and advance the offset to the next code point boundary.
 * (Post-incrementing forward iteration.)
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * The length can be negative for a NUL-terminated string.
 *
 * The offset may point to the lead surrogate unit
 * for a supplementary code point, in which case the macro will read
 * the following trail surrogate as well.
 * If the offset points to a trail surrogate or
 * to a single, unpaired lead surrogate, then c is set to U+FFFD.
 *
 * @param s const UChar * string
 * @param i string offset, must be i<length
 * @param length string length
 * @param c output UChar32 variable
 * @see U16_NEXT_UNSAFE
 * @stable ICU 60
 */
#define U16_NEXT_OR_FFFD(s, i, length, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[(i)++]; \
    if(U16_IS_SURROGATE(c)) { \
        uint16_t __c2; \
        if(U16_IS_SURROGATE_LEAD(c) && (i)!=(length) && U16_IS_TRAIL(__c2=(s)[(i)])) { \
            ++(i); \
            (c)=U16_GET_SUPPLEMENTARY((c), __c2); \
        } else { \
            (c)=0xfffd; \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Append a code point to a string, overwriting 1 or 2 code units.
 * The offset points to the current end of the string contents
 * and is advanced (post-increment).
 * "Unsafe" macro, assumes a valid code point and sufficient space in the string.
 * Otherwise, the result is undefined.
 *
 * @param s const UChar * string buffer
 * @param i string offset
 * @param c code point to append
 * @see U16_APPEND
 * @stable ICU 2.4
 */
#define U16_APPEND_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    if((uint32_t)(c)<=0xffff) { \
        (s)[(i)++]=(uint16_t)(c); \
    } else { \
        (s)[(i)++]=(uint16_t)(((c)>>10)+0xd7c0); \
        (s)[(i)++]=(uint16_t)(((c)&0x3ff)|0xdc00); \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Append a code point to a string, overwriting 1 or 2 code units.
 * The offset points to the current end of the string contents
 * and is advanced (post-increment).
 * "Safe" macro, checks for a valid code point.
 * If a surrogate pair is written, checks for sufficient space in the string.
 * If the code point is not valid or a trail surrogate does not fit,
 * then isError is set to true.
 *
 * @param s const UChar * string buffer
 * @param i string offset, must be i<capacity
 * @param capacity size of the string buffer
 * @param c code point to append
 * @param isError output UBool set to true if an error occurs, otherwise not modified
 * @see U16_APPEND_UNSAFE
 * @stable ICU 2.4
 */
#define U16_APPEND(s, i, capacity, c, isError) UPRV_BLOCK_MACRO_BEGIN { \
    if((uint32_t)(c)<=0xffff) { \
        (s)[(i)++]=(uint16_t)(c); \
    } else if((uint32_t)(c)<=0x10ffff && (i)+1<(capacity)) { \
        (s)[(i)++]=(uint16_t)(((c)>>10)+0xd7c0); \
        (s)[(i)++]=(uint16_t)(((c)&0x3ff)|0xdc00); \
    } else /* c>0x10ffff or not enough space */ { \
        (isError)=true; \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Advance the string offset from one code point boundary to the next.
 * (Post-incrementing iteration.)
 * "Unsafe" macro, assumes well-formed UTF-16.
 *
 * @param s const UChar * string
 * @param i string offset
 * @see U16_FWD_1
 * @stable ICU 2.4
 */
#define U16_FWD_1_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    if(U16_IS_LEAD((s)[(i)++])) { \
        ++(i); \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Advance the string offset from one code point boundary to the next.
 * (Post-incrementing iteration.)
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * The length can be negative for a NUL-terminated string.
 *
 * @param s const UChar * string
 * @param i string offset, must be i<length
 * @param length string length
 * @see U16_FWD_1_UNSAFE
 * @stable ICU 2.4
 */
#define U16_FWD_1(s, i, length) UPRV_BLOCK_MACRO_BEGIN { \
    if(U16_IS_LEAD((s)[(i)++]) && (i)!=(length) && U16_IS_TRAIL((s)[i])) { \
        ++(i); \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Advance the string offset from one code point boundary to the n-th next one,
 * i.e., move forward by n code points.
 * (Post-incrementing iteration.)
 * "Unsafe" macro, assumes well-formed UTF-16.
 *
 * @param s const UChar * string
 * @param i string offset
 * @param n number of code points to skip
 * @see U16_FWD_N
 * @stable ICU 2.4
 */
#define U16_FWD_N_UNSAFE(s, i, n) UPRV_BLOCK_MACRO_BEGIN { \
    int32_t __N=(n); \
    while(__N>0) { \
        U16_FWD_1_UNSAFE(s, i); \
        --__N; \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Advance the string offset from one code point boundary to the n-th next one,
 * i.e., move forward by n code points.
 * (Post-incrementing iteration.)
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * The length can be negative for a NUL-terminated string.
 *
 * @param s const UChar * string
 * @param i int32_t string offset, must be i<length
 * @param length int32_t string length
 * @param n number of code points to skip
 * @see U16_FWD_N_UNSAFE
 * @stable ICU 2.4
 */
#define U16_FWD_N(s, i, length, n) UPRV_BLOCK_MACRO_BEGIN { \
    int32_t __N=(n); \
    while(__N>0 && ((i)<(length) || ((length)<0 && (s)[i]!=0))) { \
        U16_FWD_1(s, i, length); \
        --__N; \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Adjust a random-access offset to a code point boundary
 * at the start of a code point.
 * If the offset points to the trail surrogate of a surrogate pair,
 * then the offset is decremented.
 * Otherwise, it is not modified.
 * "Unsafe" macro, assumes well-formed UTF-16.
 *
 * @param s const UChar * string
 * @param i string offset
 * @see U16_SET_CP_START
 * @stable ICU 2.4
 */
#define U16_SET_CP_START_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    if(U16_IS_TRAIL((s)[i])) { \
        --(i); \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Adjust a random-access offset to a code point boundary
 * at the start of a code point.
 * If the offset points to the trail surrogate of a surrogate pair,
 * then the offset is decremented.
 * Otherwise, it is not modified.
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * @param s const UChar * string
 * @param start starting string offset (usually 0)
 * @param i string offset, must be start<=i
 * @see U16_SET_CP_START_UNSAFE
 * @stable ICU 2.4
 */
#define U16_SET_CP_START(s, start, i) UPRV_BLOCK_MACRO_BEGIN { \
    if(U16_IS_TRAIL((s)[i]) && (i)>(start) && U16_IS_LEAD((s)[(i)-1])) { \
        --(i); \
    } \
} UPRV_BLOCK_MACRO_END

/* definitions with backward iteration -------------------------------------- */

/**
 * Move the string offset from one code point boundary to the previous one
 * and get the code point between them.
 * (Pre-decrementing backward iteration.)
 * "Unsafe" macro, assumes well-formed UTF-16.
 *
 * The input offset may be the same as the string length.
 * If the offset is behind a trail surrogate unit
 * for a supplementary code point, then the macro will read
 * the preceding lead surrogate as well.
 * If the offset is behind a lead surrogate, then that itself
 * will be returned as the code point.
 * The result is undefined if the offset is behind a single, unpaired trail surrogate.
 *
 * @param s const UChar * string
 * @param i string offset
 * @param c output UChar32 variable
 * @see U16_PREV
 * @stable ICU 2.4
 */
#define U16_PREV_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[--(i)]; \
    if(U16_IS_TRAIL(c)) { \
        (c)=U16_GET_SUPPLEMENTARY((s)[--(i)], (c)); \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Move the string offset from one code point boundary to the previous one
 * and get the code point between them.
 * (Pre-decrementing backward iteration.)
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * The input offset may be the same as the string length.
 * If the offset is behind a trail surrogate unit
 * for a supplementary code point, then the macro will read
 * the preceding lead surrogate as well.
 * If the offset is behind a lead surrogate or behind a single, unpaired
 * trail surrogate, then c is set to that unpaired surrogate.
 *
 * @param s const UChar * string
 * @param start starting string offset (usually 0)
 * @param i string offset, must be start<i
 * @param c output UChar32 variable
 * @see U16_PREV_UNSAFE
 * @stable ICU 2.4
 */
#define U16_PREV(s, start, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[--(i)]; \
    if(U16_IS_TRAIL(c)) { \
        uint16_t __c2; \
        if((i)>(start) && U16_IS_LEAD(__c2=(s)[(i)-1])) { \
            --(i); \
            (c)=U16_GET_SUPPLEMENTARY(__c2, (c)); \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Move the string offset from one code point boundary to the previous one
 * and get the code point between them.
 * (Pre-decrementing backward iteration.)
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * The input offset may be the same as the string length.
 * If the offset is behind a trail surrogate unit
 * for a supplementary code point, then the macro will read
 * the preceding lead surrogate as well.
 * If the offset is behind a lead surrogate or behind a single, unpaired
 * trail surrogate, then c is set to U+FFFD.
 *
 * @param s const UChar * string
 * @param start starting string offset (usually 0)
 * @param i string offset, must be start<i
 * @param c output UChar32 variable
 * @see U16_PREV_UNSAFE
 * @stable ICU 60
 */
#define U16_PREV_OR_FFFD(s, start, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[--(i)]; \
    if(U16_IS_SURROGATE(c)) { \
        uint16_t __c2; \
        if(U16_IS_SURROGATE_TRAIL(c) && (i)>(start) && U16_IS_LEAD(__c2=(s)[(i)-1])) { \
            --(i); \
            (c)=U16_GET_SUPPLEMENTARY(__c2, (c)); \
        } else { \
            (c)=0xfffd; \
        } \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Move the string offset from one code point boundary to the previous one.
 * (Pre-decrementing backward iteration.)
 * The input offset may be the same as the string length.
 * "Unsafe" macro, assumes well-formed UTF-16.
 *
 * @param s const UChar * string
 * @param i string offset
 * @see U16_BACK_1
 * @stable ICU 2.4
 */
#define U16_BACK_1_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    if(U16_IS_TRAIL((s)[--(i)])) { \
        --(i); \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Move the string offset from one code point boundary to the previous one.
 * (Pre-decrementing backward iteration.)
 * The input offset may be the same as the string length.
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * @param s const UChar * string
 * @param start starting string offset (usually 0)
 * @param i string offset, must be start<i
 * @see U16_BACK_1_UNSAFE
 * @stable ICU 2.4
 */
#define U16_BACK_1(s, start, i) UPRV_BLOCK_MACRO_BEGIN { \
    if(U16_IS_TRAIL((s)[--(i)]) && (i)>(start) && U16_IS_LEAD((s)[(i)-1])) { \
        --(i); \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Move the string offset from one code point boundary to the n-th one before it,
 * i.e., move backward by n code points.
 * (Pre-decrementing backward iteration.)
 * The input offset may be the same as the string length.
 * "Unsafe" macro, assumes well-formed UTF-16.
 *
 * @param s const UChar * string
 * @param i string offset
 * @param n number of code points to skip
 * @see U16_BACK_N
 * @stable ICU 2.4
 */
#define U16_BACK_N_UNSAFE(s, i, n) UPRV_BLOCK_MACRO_BEGIN { \
    int32_t __N=(n); \
    while(__N>0) { \
        U16_BACK_1_UNSAFE(s, i); \
        --__N; \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Move the string offset from one code point boundary to the n-th one before it,
 * i.e., move backward by n code points.
 * (Pre-decrementing backward iteration.)
 * The input offset may be the same as the string length.
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * @param s const UChar * string
 * @param start start of string
 * @param i string offset, must be start<i
 * @param n number of code points to skip
 * @see U16_BACK_N_UNSAFE
 * @stable ICU 2.4
 */
#define U16_BACK_N(s, start, i, n) UPRV_BLOCK_MACRO_BEGIN { \
    int32_t __N=(n); \
    while(__N>0 && (i)>(start)) { \
        U16_BACK_1(s, start, i); \
        --__N; \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Adjust a random-access offset to a code point boundary after a code point.
 * If the offset is behind the lead surrogate of a surrogate pair,
 * then the offset is incremented.
 * Otherwise, it is not modified.
 * The input offset may be the same as the string length.
 * "Unsafe" macro, assumes well-formed UTF-16.
 *
 * @param s const UChar * string
 * @param i string offset
 * @see U16_SET_CP_LIMIT
 * @stable ICU 2.4
 */
#define U16_SET_CP_LIMIT_UNSAFE(s, i) UPRV_BLOCK_MACRO_BEGIN { \
    if(U16_IS_LEAD((s)[(i)-1])) { \
        ++(i); \
    } \
} UPRV_BLOCK_MACRO_END

/**
 * Adjust a random-access offset to a code point boundary after a code point.
 * If the offset is behind the lead surrogate of a surrogate pair,
 * then the offset is incremented.
 * Otherwise, it is not modified.
 * The input offset may be the same as the string length.
 * "Safe" macro, handles unpaired surrogates and checks for string boundaries.
 *
 * The length can be negative for a NUL-terminated string.
 *
 * @param s const UChar * string
 * @param start int32_t starting string offset (usually 0)
 * @param i int32_t string offset, start<=i<=length
 * @param length int32_t string length
 * @see U16_SET_CP_LIMIT_UNSAFE
 * @stable ICU 2.4
 */
#define U16_SET_CP_LIMIT(s, start, i, length) UPRV_BLOCK_MACRO_BEGIN { \
    if((start)<(i) && ((i)<(length) || (length)<0) && U16_IS_LEAD((s)[(i)-1]) && U16_IS_TRAIL((s)[i])) { \
        ++(i); \
    } \
} UPRV_BLOCK_MACRO_END

#endif
