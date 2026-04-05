// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 1998-2014, International Business Machines
*   Corporation and others.  All Rights Reserved.
**********************************************************************
*
* File ustring.h
*
* Modification History:
*
*   Date        Name        Description
*   12/07/98    bertrand    Creation.
******************************************************************************
*/

#ifndef USTRING_H
#define USTRING_H

#include "unicode/utypes.h"
#include "unicode/putil.h"
#include "unicode/uiter.h"

/**
 * \def UBRK_TYPEDEF_UBREAK_ITERATOR
 * @internal 
 */

#ifndef UBRK_TYPEDEF_UBREAK_ITERATOR
#   define UBRK_TYPEDEF_UBREAK_ITERATOR
/** Simple declaration for u_strToTitle() to avoid including unicode/ubrk.h. @stable ICU 2.1*/
    typedef struct UBreakIterator UBreakIterator;
#endif

/**
 * \file
 * \brief C API: Unicode string handling functions
 *
 * These C API functions provide general Unicode string handling.
 *
 * Some functions are equivalent in name, signature, and behavior to the ANSI C <string.h>
 * functions. (For example, they do not check for bad arguments like NULL string pointers.)
 * In some cases, only the thread-safe variant of such a function is implemented here
 * (see u_strtok_r()).
 *
 * Other functions provide more Unicode-specific functionality like locale-specific
 * upper/lower-casing and string comparison in code point order.
 *
 * ICU uses 16-bit Unicode (UTF-16) in the form of arrays of UChar code units.
 * UTF-16 encodes each Unicode code point with either one or two UChar code units.
 * (This is the default form of Unicode, and a forward-compatible extension of the original,
 * fixed-width form that was known as UCS-2. UTF-16 superseded UCS-2 with Unicode 2.0
 * in 1996.)
 *
 * Some APIs accept a 32-bit UChar32 value for a single code point.
 *
 * ICU also handles 16-bit Unicode text with unpaired surrogates.
 * Such text is not well-formed UTF-16.
 * Code-point-related functions treat unpaired surrogates as surrogate code points,
 * i.e., as separate units.
 *
 * Although UTF-16 is a variable-width encoding form (like some legacy multi-byte encodings),
 * it is much more efficient even for random access because the code unit values
 * for single-unit characters vs. lead units vs. trail units are completely disjoint.
 * This means that it is easy to determine character (code point) boundaries from
 * random offsets in the string.
 *
 * Unicode (UTF-16) string processing is optimized for the single-unit case.
 * Although it is important to support supplementary characters
 * (which use pairs of lead/trail code units called "surrogates"),
 * their occurrence is rare. Almost all characters in modern use require only
 * a single UChar code unit (i.e., their code point values are <=0xffff).
 *
 * For more details see the User Guide Strings chapter (https://unicode-org.github.io/icu/userguide/strings/).
 * For a discussion of the handling of unpaired surrogates see also
 * Jitterbug 2145 and its icu mailing list proposal on 2002-sep-18.
 */

/**
 * \defgroup ustring_ustrlen String Length
 * \ingroup ustring_strlen
 */
/*@{*/
/**
 * Determine the length of an array of UChar.
 *
 * @param s The array of UChars, NULL (U+0000) terminated.
 * @return The number of UChars in <code>chars</code>, minus the terminator.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_strlen(const UChar *s);
/*@}*/

/**
 * Count Unicode code points in the length UChar code units of the string.
 * A code point may occupy either one or two UChar code units.
 * Counting code points involves reading all code units.
 *
 * This functions is basically the inverse of the U16_FWD_N() macro (see utf.h).
 *
 * @param s The input string.
 * @param length The number of UChar code units to be checked, or -1 to count all
 *               code points before the first NUL (U+0000).
 * @return The number of code points in the specified code units.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_countChar32(const UChar *s, int32_t length);

/**
 * Check if the string contains more Unicode code points than a certain number.
 * This is more efficient than counting all code points in the entire string
 * and comparing that number with a threshold.
 * This function may not need to scan the string at all if the length is known
 * (not -1 for NUL-termination) and falls within a certain range, and
 * never needs to count more than 'number+1' code points.
 * Logically equivalent to (u_countChar32(s, length)>number).
 * A Unicode code point may occupy either one or two UChar code units.
 *
 * @param s The input string.
 * @param length The length of the string, or -1 if it is NUL-terminated.
 * @param number The number of code points in the string is compared against
 *               the 'number' parameter.
 * @return Boolean value for whether the string contains more Unicode code points
 *         than 'number'. Same as (u_countChar32(s, length)>number).
 * @stable ICU 2.4
 */
U_CAPI UBool U_EXPORT2
u_strHasMoreChar32Than(const UChar *s, int32_t length, int32_t number);

/**
 * Concatenate two ustrings.  Appends a copy of <code>src</code>,
 * including the null terminator, to <code>dst</code>. The initial copied
 * character from <code>src</code> overwrites the null terminator in <code>dst</code>.
 *
 * @param dst The destination string.
 * @param src The source string.
 * @return A pointer to <code>dst</code>.
 * @stable ICU 2.0
 */
U_CAPI UChar* U_EXPORT2
u_strcat(UChar     *dst, 
    const UChar     *src);

/**
 * Concatenate two ustrings.  
 * Appends at most <code>n</code> characters from <code>src</code> to <code>dst</code>.
 * Adds a terminating NUL.
 * If src is too long, then only <code>n-1</code> characters will be copied
 * before the terminating NUL.
 * If <code>n&lt;=0</code> then dst is not modified.
 *
 * @param dst The destination string.
 * @param src The source string (can be NULL/invalid if n<=0).
 * @param n The maximum number of characters to append; no-op if <=0.
 * @return A pointer to <code>dst</code>.
 * @stable ICU 2.0
 */
U_CAPI UChar* U_EXPORT2
u_strncat(UChar     *dst, 
     const UChar     *src, 
     int32_t     n);

/**
 * Find the first occurrence of a substring in a string.
 * The substring is found at code point boundaries.
 * That means that if the substring begins with
 * a trail surrogate or ends with a lead surrogate,
 * then it is found only if these surrogates stand alone in the text.
 * Otherwise, the substring edge units would be matched against
 * halves of surrogate pairs.
 *
 * @param s The string to search (NUL-terminated).
 * @param substring The substring to find (NUL-terminated).
 * @return A pointer to the first occurrence of <code>substring</code> in <code>s</code>,
 *         or <code>s</code> itself if the <code>substring</code> is empty,
 *         or <code>NULL</code> if <code>substring</code> is not in <code>s</code>.
 * @stable ICU 2.0
 *
 * @see u_strrstr
 * @see u_strFindFirst
 * @see u_strFindLast
 */
U_CAPI UChar * U_EXPORT2
u_strstr(const UChar *s, const UChar *substring);

/**
 * Find the first occurrence of a substring in a string.
 * The substring is found at code point boundaries.
 * That means that if the substring begins with
 * a trail surrogate or ends with a lead surrogate,
 * then it is found only if these surrogates stand alone in the text.
 * Otherwise, the substring edge units would be matched against
 * halves of surrogate pairs.
 *
 * @param s The string to search.
 * @param length The length of s (number of UChars), or -1 if it is NUL-terminated.
 * @param substring The substring to find (NUL-terminated).
 * @param subLength The length of substring (number of UChars), or -1 if it is NUL-terminated.
 * @return A pointer to the first occurrence of <code>substring</code> in <code>s</code>,
 *         or <code>s</code> itself if the <code>substring</code> is empty,
 *         or <code>NULL</code> if <code>substring</code> is not in <code>s</code>.
 * @stable ICU 2.4
 *
 * @see u_strstr
 * @see u_strFindLast
 */
U_CAPI UChar * U_EXPORT2
u_strFindFirst(const UChar *s, int32_t length, const UChar *substring, int32_t subLength);

/**
 * Find the first occurrence of a BMP code point in a string.
 * A surrogate code point is found only if its match in the text is not
 * part of a surrogate pair.
 * A NUL character is found at the string terminator.
 *
 * @param s The string to search (NUL-terminated).
 * @param c The BMP code point to find.
 * @return A pointer to the first occurrence of <code>c</code> in <code>s</code>
 *         or <code>NULL</code> if <code>c</code> is not in <code>s</code>.
 * @stable ICU 2.0
 *
 * @see u_strchr32
 * @see u_memchr
 * @see u_strstr
 * @see u_strFindFirst
 */
U_CAPI UChar * U_EXPORT2
u_strchr(const UChar *s, UChar c);

/**
 * Find the first occurrence of a code point in a string.
 * A surrogate code point is found only if its match in the text is not
 * part of a surrogate pair.
 * A NUL character is found at the string terminator.
 *
 * @param s The string to search (NUL-terminated).
 * @param c The code point to find.
 * @return A pointer to the first occurrence of <code>c</code> in <code>s</code>
 *         or <code>NULL</code> if <code>c</code> is not in <code>s</code>.
 * @stable ICU 2.0
 *
 * @see u_strchr
 * @see u_memchr32
 * @see u_strstr
 * @see u_strFindFirst
 */
U_CAPI UChar * U_EXPORT2
u_strchr32(const UChar *s, UChar32 c);

/**
 * Find the last occurrence of a substring in a string.
 * The substring is found at code point boundaries.
 * That means that if the substring begins with
 * a trail surrogate or ends with a lead surrogate,
 * then it is found only if these surrogates stand alone in the text.
 * Otherwise, the substring edge units would be matched against
 * halves of surrogate pairs.
 *
 * @param s The string to search (NUL-terminated).
 * @param substring The substring to find (NUL-terminated).
 * @return A pointer to the last occurrence of <code>substring</code> in <code>s</code>,
 *         or <code>s</code> itself if the <code>substring</code> is empty,
 *         or <code>NULL</code> if <code>substring</code> is not in <code>s</code>.
 * @stable ICU 2.4
 *
 * @see u_strstr
 * @see u_strFindFirst
 * @see u_strFindLast
 */
U_CAPI UChar * U_EXPORT2
u_strrstr(const UChar *s, const UChar *substring);

/**
 * Find the last occurrence of a substring in a string.
 * The substring is found at code point boundaries.
 * That means that if the substring begins with
 * a trail surrogate or ends with a lead surrogate,
 * then it is found only if these surrogates stand alone in the text.
 * Otherwise, the substring edge units would be matched against
 * halves of surrogate pairs.
 *
 * @param s The string to search.
 * @param length The length of s (number of UChars), or -1 if it is NUL-terminated.
 * @param substring The substring to find (NUL-terminated).
 * @param subLength The length of substring (number of UChars), or -1 if it is NUL-terminated.
 * @return A pointer to the last occurrence of <code>substring</code> in <code>s</code>,
 *         or <code>s</code> itself if the <code>substring</code> is empty,
 *         or <code>NULL</code> if <code>substring</code> is not in <code>s</code>.
 * @stable ICU 2.4
 *
 * @see u_strstr
 * @see u_strFindLast
 */
U_CAPI UChar * U_EXPORT2
u_strFindLast(const UChar *s, int32_t length, const UChar *substring, int32_t subLength);

/**
 * Find the last occurrence of a BMP code point in a string.
 * A surrogate code point is found only if its match in the text is not
 * part of a surrogate pair.
 * A NUL character is found at the string terminator.
 *
 * @param s The string to search (NUL-terminated).
 * @param c The BMP code point to find.
 * @return A pointer to the last occurrence of <code>c</code> in <code>s</code>
 *         or <code>NULL</code> if <code>c</code> is not in <code>s</code>.
 * @stable ICU 2.4
 *
 * @see u_strrchr32
 * @see u_memrchr
 * @see u_strrstr
 * @see u_strFindLast
 */
U_CAPI UChar * U_EXPORT2
u_strrchr(const UChar *s, UChar c);

/**
 * Find the last occurrence of a code point in a string.
 * A surrogate code point is found only if its match in the text is not
 * part of a surrogate pair.
 * A NUL character is found at the string terminator.
 *
 * @param s The string to search (NUL-terminated).
 * @param c The code point to find.
 * @return A pointer to the last occurrence of <code>c</code> in <code>s</code>
 *         or <code>NULL</code> if <code>c</code> is not in <code>s</code>.
 * @stable ICU 2.4
 *
 * @see u_strrchr
 * @see u_memchr32
 * @see u_strrstr
 * @see u_strFindLast
 */
U_CAPI UChar * U_EXPORT2
u_strrchr32(const UChar *s, UChar32 c);

/**
 * Locates the first occurrence in the string <code>string</code> of any of the characters
 * in the string <code>matchSet</code>.
 * Works just like C's strpbrk but with Unicode.
 *
 * @param string The string in which to search, NUL-terminated.
 * @param matchSet A NUL-terminated string defining a set of code points
 *                 for which to search in the text string.
 * @return A pointer to the  character in <code>string</code> that matches one of the
 *         characters in <code>matchSet</code>, or NULL if no such character is found.
 * @stable ICU 2.0
 */
U_CAPI UChar * U_EXPORT2
u_strpbrk(const UChar *string, const UChar *matchSet);

/**
 * Returns the number of consecutive characters in <code>string</code>,
 * beginning with the first, that do not occur somewhere in <code>matchSet</code>.
 * Works just like C's strcspn but with Unicode.
 *
 * @param string The string in which to search, NUL-terminated.
 * @param matchSet A NUL-terminated string defining a set of code points
 *                 for which to search in the text string.
 * @return The number of initial characters in <code>string</code> that do not
 *         occur in <code>matchSet</code>.
 * @see u_strspn
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_strcspn(const UChar *string, const UChar *matchSet);

/**
 * Returns the number of consecutive characters in <code>string</code>,
 * beginning with the first, that occur somewhere in <code>matchSet</code>.
 * Works just like C's strspn but with Unicode.
 *
 * @param string The string in which to search, NUL-terminated.
 * @param matchSet A NUL-terminated string defining a set of code points
 *                 for which to search in the text string.
 * @return The number of initial characters in <code>string</code> that do
 *         occur in <code>matchSet</code>.
 * @see u_strcspn
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_strspn(const UChar *string, const UChar *matchSet);

/**
 * The string tokenizer API allows an application to break a string into
 * tokens. Unlike strtok(), the saveState (the current pointer within the
 * original string) is maintained in saveState. In the first call, the
 * argument src is a pointer to the string. In subsequent calls to
 * return successive tokens of that string, src must be specified as
 * NULL. The value saveState is set by this function to maintain the
 * function's position within the string, and on each subsequent call
 * you must give this argument the same variable. This function does
 * handle surrogate pairs. This function is similar to the strtok_r()
 * the POSIX Threads Extension (1003.1c-1995) version.
 *
 * @param src String containing token(s). This string will be modified.
 *            After the first call to u_strtok_r(), this argument must
 *            be NULL to get to the next token.
 * @param delim Set of delimiter characters (Unicode code points).
 * @param saveState The current pointer within the original string,
 *              which is set by this function. The saveState
 *              parameter should the address of a local variable of type
 *              UChar *. (i.e. defined "UChar *myLocalSaveState" and use
 *              &myLocalSaveState for this parameter).
 * @return A pointer to the next token found in src, or NULL
 *         when there are no more tokens.
 * @stable ICU 2.0
 */
U_CAPI UChar * U_EXPORT2
u_strtok_r(UChar    *src, 
     const UChar    *delim,
           UChar   **saveState);

/**
 * Compare two Unicode strings for bitwise equality (code unit order).
 *
 * @param s1 A string to compare.
 * @param s2 A string to compare.
 * @return 0 if <code>s1</code> and <code>s2</code> are bitwise equal; a negative
 * value if <code>s1</code> is bitwise less than <code>s2,</code>; a positive
 * value if <code>s1</code> is bitwise greater than <code>s2</code>.
 * @stable ICU 2.0
 */
U_CAPI int32_t  U_EXPORT2
u_strcmp(const UChar     *s1, 
         const UChar     *s2);

/**
 * Compare two Unicode strings in code point order.
 * See u_strCompare for details.
 *
 * @param s1 A string to compare.
 * @param s2 A string to compare.
 * @return a negative/zero/positive integer corresponding to whether
 * the first string is less than/equal to/greater than the second one
 * in code point order
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_strcmpCodePointOrder(const UChar *s1, const UChar *s2);

/**
 * Compare two Unicode strings (binary order).
 *
 * The comparison can be done in code unit order or in code point order.
 * They differ only in UTF-16 when
 * comparing supplementary code points (U+10000..U+10ffff)
 * to BMP code points near the end of the BMP (i.e., U+e000..U+ffff).
 * In code unit order, high BMP code points sort after supplementary code points
 * because they are stored as pairs of surrogates which are at U+d800..U+dfff.
 *
 * This functions works with strings of different explicitly specified lengths
 * unlike the ANSI C-like u_strcmp() and u_memcmp() etc.
 * NUL-terminated strings are possible with length arguments of -1.
 *
 * @param s1 First source string.
 * @param length1 Length of first source string, or -1 if NUL-terminated.
 *
 * @param s2 Second source string.
 * @param length2 Length of second source string, or -1 if NUL-terminated.
 *
 * @param codePointOrder Choose between code unit order (false)
 *                       and code point order (true).
 *
 * @return <0 or 0 or >0 as usual for string comparisons
 *
 * @stable ICU 2.2
 */
U_CAPI int32_t U_EXPORT2
u_strCompare(const UChar *s1, int32_t length1,
             const UChar *s2, int32_t length2,
             UBool codePointOrder);

/**
 * Compare two Unicode strings (binary order)
 * as presented by UCharIterator objects.
 * Works otherwise just like u_strCompare().
 *
 * Both iterators are reset to their start positions.
 * When the function returns, it is undefined where the iterators
 * have stopped.
 *
 * @param iter1 First source string iterator.
 * @param iter2 Second source string iterator.
 * @param codePointOrder Choose between code unit order (false)
 *                       and code point order (true).
 *
 * @return <0 or 0 or >0 as usual for string comparisons
 *
 * @see u_strCompare
 *
 * @stable ICU 2.6
 */
U_CAPI int32_t U_EXPORT2
u_strCompareIter(UCharIterator *iter1, UCharIterator *iter2, UBool codePointOrder);

/**
 * Compare two strings case-insensitively using full case folding.
 * This is equivalent to
 *   u_strCompare(u_strFoldCase(s1, options),
 *                u_strFoldCase(s2, options),
 *                (options&U_COMPARE_CODE_POINT_ORDER)!=0).
 *
 * The comparison can be done in UTF-16 code unit order or in code point order.
 * They differ only when comparing supplementary code points (U+10000..U+10ffff)
 * to BMP code points near the end of the BMP (i.e., U+e000..U+ffff).
 * In code unit order, high BMP code points sort after supplementary code points
 * because they are stored as pairs of surrogates which are at U+d800..U+dfff.
 *
 * This functions works with strings of different explicitly specified lengths
 * unlike the ANSI C-like u_strcmp() and u_memcmp() etc.
 * NUL-terminated strings are possible with length arguments of -1.
 *
 * @param s1 First source string.
 * @param length1 Length of first source string, or -1 if NUL-terminated.
 *
 * @param s2 Second source string.
 * @param length2 Length of second source string, or -1 if NUL-terminated.
 *
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
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                  which must not indicate a failure before the function call.
 *
 * @return <0 or 0 or >0 as usual for string comparisons
 *
 * @stable ICU 2.2
 */
U_CAPI int32_t U_EXPORT2
u_strCaseCompare(const UChar *s1, int32_t length1,
                 const UChar *s2, int32_t length2,
                 uint32_t options,
                 UErrorCode *pErrorCode);

/**
 * Compare two ustrings for bitwise equality. 
 * Compares at most <code>n</code> characters.
 *
 * @param ucs1 A string to compare (can be NULL/invalid if n<=0).
 * @param ucs2 A string to compare (can be NULL/invalid if n<=0).
 * @param n The maximum number of characters to compare; always returns 0 if n<=0.
 * @return 0 if <code>s1</code> and <code>s2</code> are bitwise equal; a negative
 * value if <code>s1</code> is bitwise less than <code>s2</code>; a positive
 * value if <code>s1</code> is bitwise greater than <code>s2</code>.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_strncmp(const UChar     *ucs1, 
     const UChar     *ucs2, 
     int32_t     n);

/**
 * Compare two Unicode strings in code point order.
 * This is different in UTF-16 from u_strncmp() if supplementary characters are present.
 * For details, see u_strCompare().
 *
 * @param s1 A string to compare.
 * @param s2 A string to compare.
 * @param n The maximum number of characters to compare.
 * @return a negative/zero/positive integer corresponding to whether
 * the first string is less than/equal to/greater than the second one
 * in code point order
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_strncmpCodePointOrder(const UChar *s1, const UChar *s2, int32_t n);

/**
 * Compare two strings case-insensitively using full case folding.
 * This is equivalent to u_strcmp(u_strFoldCase(s1, options), u_strFoldCase(s2, options)).
 *
 * @param s1 A string to compare.
 * @param s2 A string to compare.
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
U_CAPI int32_t U_EXPORT2
u_strcasecmp(const UChar *s1, const UChar *s2, uint32_t options);

/**
 * Compare two strings case-insensitively using full case folding.
 * This is equivalent to u_strcmp(u_strFoldCase(s1, at most n, options),
 * u_strFoldCase(s2, at most n, options)).
 *
 * @param s1 A string to compare.
 * @param s2 A string to compare.
 * @param n The maximum number of characters each string to case-fold and then compare.
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
U_CAPI int32_t U_EXPORT2
u_strncasecmp(const UChar *s1, const UChar *s2, int32_t n, uint32_t options);

/**
 * Compare two strings case-insensitively using full case folding.
 * This is equivalent to u_strcmp(u_strFoldCase(s1, n, options),
 * u_strFoldCase(s2, n, options)).
 *
 * @param s1 A string to compare.
 * @param s2 A string to compare.
 * @param length The number of characters in each string to case-fold and then compare.
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
U_CAPI int32_t U_EXPORT2
u_memcasecmp(const UChar *s1, const UChar *s2, int32_t length, uint32_t options);

/**
 * Copy a ustring. Adds a null terminator.
 *
 * @param dst The destination string.
 * @param src The source string.
 * @return A pointer to <code>dst</code>.
 * @stable ICU 2.0
 */
U_CAPI UChar* U_EXPORT2
u_strcpy(UChar     *dst, 
    const UChar     *src);

/**
 * Copy a ustring.
 * Copies at most <code>n</code> characters.  The result will be null terminated
 * if the length of <code>src</code> is less than <code>n</code>.
 *
 * @param dst The destination string.
 * @param src The source string (can be NULL/invalid if n<=0).
 * @param n The maximum number of characters to copy; no-op if <=0.
 * @return A pointer to <code>dst</code>.
 * @stable ICU 2.0
 */
U_CAPI UChar* U_EXPORT2
u_strncpy(UChar     *dst, 
     const UChar     *src, 
     int32_t     n);

#if !UCONFIG_NO_CONVERSION

/**
 * Copy a byte string encoded in the default codepage to a ustring.
 * Adds a null terminator.
 * Performs a host byte to UChar conversion
 *
 * @param dst The destination string.
 * @param src The source string.
 * @return A pointer to <code>dst</code>.
 * @stable ICU 2.0
 */
U_CAPI UChar* U_EXPORT2 u_uastrcpy(UChar *dst,
               const char *src );

/**
 * Copy a byte string encoded in the default codepage to a ustring.
 * Copies at most <code>n</code> characters.  The result will be null terminated
 * if the length of <code>src</code> is less than <code>n</code>.
 * Performs a host byte to UChar conversion
 *
 * @param dst The destination string.
 * @param src The source string.
 * @param n The maximum number of characters to copy.
 * @return A pointer to <code>dst</code>.
 * @stable ICU 2.0
 */
U_CAPI UChar* U_EXPORT2 u_uastrncpy(UChar *dst,
            const char *src,
            int32_t n);

/**
 * Copy ustring to a byte string encoded in the default codepage.
 * Adds a null terminator.
 * Performs a UChar to host byte conversion
 *
 * @param dst The destination string.
 * @param src The source string.
 * @return A pointer to <code>dst</code>.
 * @stable ICU 2.0
 */
U_CAPI char* U_EXPORT2 u_austrcpy(char *dst,
            const UChar *src );

/**
 * Copy ustring to a byte string encoded in the default codepage.
 * Copies at most <code>n</code> characters.  The result will be null terminated
 * if the length of <code>src</code> is less than <code>n</code>.
 * Performs a UChar to host byte conversion
 *
 * @param dst The destination string.
 * @param src The source string.
 * @param n The maximum number of characters to copy.
 * @return A pointer to <code>dst</code>.
 * @stable ICU 2.0
 */
U_CAPI char* U_EXPORT2 u_austrncpy(char *dst,
            const UChar *src,
            int32_t n );

#endif

/**
 * Synonym for memcpy(), but with UChars only.
 * @param dest The destination string
 * @param src The source string (can be NULL/invalid if count<=0)
 * @param count The number of characters to copy; no-op if <=0
 * @return A pointer to <code>dest</code>
 * @stable ICU 2.0
 */
U_CAPI UChar* U_EXPORT2
u_memcpy(UChar *dest, const UChar *src, int32_t count);

/**
 * Synonym for memmove(), but with UChars only.
 * @param dest The destination string
 * @param src The source string (can be NULL/invalid if count<=0)
 * @param count The number of characters to move; no-op if <=0
 * @return A pointer to <code>dest</code>
 * @stable ICU 2.0
 */
U_CAPI UChar* U_EXPORT2
u_memmove(UChar *dest, const UChar *src, int32_t count);

/**
 * Initialize <code>count</code> characters of <code>dest</code> to <code>c</code>.
 *
 * @param dest The destination string.
 * @param c The character to initialize the string.
 * @param count The maximum number of characters to set.
 * @return A pointer to <code>dest</code>.
 * @stable ICU 2.0
 */
U_CAPI UChar* U_EXPORT2
u_memset(UChar *dest, UChar c, int32_t count);

/**
 * Compare the first <code>count</code> UChars of each buffer.
 *
 * @param buf1 The first string to compare.
 * @param buf2 The second string to compare.
 * @param count The maximum number of UChars to compare.
 * @return When buf1 < buf2, a negative number is returned.
 *      When buf1 == buf2, 0 is returned.
 *      When buf1 > buf2, a positive number is returned.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_memcmp(const UChar *buf1, const UChar *buf2, int32_t count);

/**
 * Compare two Unicode strings in code point order.
 * This is different in UTF-16 from u_memcmp() if supplementary characters are present.
 * For details, see u_strCompare().
 *
 * @param s1 A string to compare.
 * @param s2 A string to compare.
 * @param count The maximum number of characters to compare.
 * @return a negative/zero/positive integer corresponding to whether
 * the first string is less than/equal to/greater than the second one
 * in code point order
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_memcmpCodePointOrder(const UChar *s1, const UChar *s2, int32_t count);

/**
 * Find the first occurrence of a BMP code point in a string.
 * A surrogate code point is found only if its match in the text is not
 * part of a surrogate pair.
 * A NUL character is found at the string terminator.
 *
 * @param s The string to search (contains <code>count</code> UChars).
 * @param c The BMP code point to find.
 * @param count The length of the string.
 * @return A pointer to the first occurrence of <code>c</code> in <code>s</code>
 *         or <code>NULL</code> if <code>c</code> is not in <code>s</code>.
 * @stable ICU 2.0
 *
 * @see u_strchr
 * @see u_memchr32
 * @see u_strFindFirst
 */
U_CAPI UChar* U_EXPORT2
u_memchr(const UChar *s, UChar c, int32_t count);

/**
 * Find the first occurrence of a code point in a string.
 * A surrogate code point is found only if its match in the text is not
 * part of a surrogate pair.
 * A NUL character is found at the string terminator.
 *
 * @param s The string to search (contains <code>count</code> UChars).
 * @param c The code point to find.
 * @param count The length of the string.
 * @return A pointer to the first occurrence of <code>c</code> in <code>s</code>
 *         or <code>NULL</code> if <code>c</code> is not in <code>s</code>.
 * @stable ICU 2.0
 *
 * @see u_strchr32
 * @see u_memchr
 * @see u_strFindFirst
 */
U_CAPI UChar* U_EXPORT2
u_memchr32(const UChar *s, UChar32 c, int32_t count);

/**
 * Find the last occurrence of a BMP code point in a string.
 * A surrogate code point is found only if its match in the text is not
 * part of a surrogate pair.
 * A NUL character is found at the string terminator.
 *
 * @param s The string to search (contains <code>count</code> UChars).
 * @param c The BMP code point to find.
 * @param count The length of the string.
 * @return A pointer to the last occurrence of <code>c</code> in <code>s</code>
 *         or <code>NULL</code> if <code>c</code> is not in <code>s</code>.
 * @stable ICU 2.4
 *
 * @see u_strrchr
 * @see u_memrchr32
 * @see u_strFindLast
 */
U_CAPI UChar* U_EXPORT2
u_memrchr(const UChar *s, UChar c, int32_t count);

/**
 * Find the last occurrence of a code point in a string.
 * A surrogate code point is found only if its match in the text is not
 * part of a surrogate pair.
 * A NUL character is found at the string terminator.
 *
 * @param s The string to search (contains <code>count</code> UChars).
 * @param c The code point to find.
 * @param count The length of the string.
 * @return A pointer to the last occurrence of <code>c</code> in <code>s</code>
 *         or <code>NULL</code> if <code>c</code> is not in <code>s</code>.
 * @stable ICU 2.4
 *
 * @see u_strrchr32
 * @see u_memrchr
 * @see u_strFindLast
 */
U_CAPI UChar* U_EXPORT2
u_memrchr32(const UChar *s, UChar32 c, int32_t count);

/**
 * Unicode String literals in C.
 * We need one macro to declare a variable for the string
 * and to statically preinitialize it if possible,
 * and a second macro to dynamically initialize such a string variable if necessary.
 *
 * The macros are defined for maximum performance.
 * They work only for strings that contain "invariant characters", i.e.,
 * only latin letters, digits, and some punctuation.
 * See utypes.h for details.
 *
 * A pair of macros for a single string must be used with the same
 * parameters.
 * The string parameter must be a C string literal.
 * The length of the string, not including the terminating
 * `NUL`, must be specified as a constant.
 * The U_STRING_DECL macro should be invoked exactly once for one
 * such string variable before it is used.
 *
 * Usage:
 *
 *     U_STRING_DECL(ustringVar1, "Quick-Fox 2", 11);
 *     U_STRING_DECL(ustringVar2, "jumps 5%", 8);
 *     static UBool didInit=false;
 *
 *     int32_t function() {
 *         if(!didInit) {
 *             U_STRING_INIT(ustringVar1, "Quick-Fox 2", 11);
 *             U_STRING_INIT(ustringVar2, "jumps 5%", 8);
 *             didInit=true;
 *         }
 *         return u_strcmp(ustringVar1, ustringVar2);
 *     }
 * 
 * Note that the macros will NOT consistently work if their argument is another #`define`.
 * The following will not work on all platforms, don't use it.
 * 
 *     #define GLUCK "Mr. Gluck"
 *     U_STRING_DECL(var, GLUCK, 9)
 *     U_STRING_INIT(var, GLUCK, 9)
 *
 * Instead, use the string literal "Mr. Gluck"  as the argument to both macro
 * calls.
 *
 *
 * @stable ICU 2.0
 */
#if defined(U_DECLARE_UTF16)
#   define U_STRING_DECL(var, cs, length) static const UChar *var=(const UChar *)U_DECLARE_UTF16(cs)
    /**@stable ICU 2.0 */
#   define U_STRING_INIT(var, cs, length)
#elif U_SIZEOF_WCHAR_T==U_SIZEOF_UCHAR && (U_CHARSET_FAMILY==U_ASCII_FAMILY || defined(U_WCHAR_IS_UTF16))
#   define U_STRING_DECL(var, cs, length) static const UChar var[(length)+1]=L ## cs
    /**@stable ICU 2.0 */
#   define U_STRING_INIT(var, cs, length)
#else
#   define U_STRING_DECL(var, cs, length) static UChar var[(length)+1]
    /**@stable ICU 2.0 */
#   define U_STRING_INIT(var, cs, length) u_charsToUChars(cs, var, length+1)
#endif

/**
 * Unescape a string of characters and write the resulting
 * Unicode characters to the destination buffer.  The following escape
 * sequences are recognized:
 *
 * \\uhhhh       4 hex digits; h in [0-9A-Fa-f]
 * \\Uhhhhhhhh   8 hex digits
 * \\xhh         1-2 hex digits
 * \\x{h...}     1-8 hex digits
 * \\ooo         1-3 octal digits; o in [0-7]
 * \\cX          control-X; X is masked with 0x1F
 *
 * as well as the standard ANSI C escapes:
 *
 * \\a => U+0007, \\b => U+0008, \\t => U+0009, \\n => U+000A,
 * \\v => U+000B, \\f => U+000C, \\r => U+000D, \\e => U+001B,
 * \\&quot; => U+0022, \\' => U+0027, \\? => U+003F, \\\\ => U+005C
 *
 * Anything else following a backslash is generically escaped.  For
 * example, "[a\\-z]" returns "[a-z]".
 *
 * If an escape sequence is ill-formed, this method returns an empty
 * string.  An example of an ill-formed sequence is "\\u" followed by
 * fewer than 4 hex digits.
 *
 * The above characters are recognized in the compiler's codepage,
 * that is, they are coded as 'u', '\\', etc.  Characters that are
 * not parts of escape sequences are converted using u_charsToUChars().
 *
 * This function is similar to UnicodeString::unescape() but not
 * identical to it.  The latter takes a source UnicodeString, so it
 * does escape recognition but no conversion.
 *
 * @param src a zero-terminated string of invariant characters
 * @param dest pointer to buffer to receive converted and unescaped
 * text and, if there is room, a zero terminator.  May be NULL for
 * preflighting, in which case no UChars will be written, but the
 * return value will still be valid.  On error, an empty string is
 * stored here (if possible).
 * @param destCapacity the number of UChars that may be written at
 * dest.  Ignored if dest == NULL.
 * @return the length of unescaped string.
 * @see u_unescapeAt
 * @see UnicodeString#unescape()
 * @see UnicodeString#unescapeAt()
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_unescape(const char *src,
           UChar *dest, int32_t destCapacity);

U_CDECL_BEGIN
/**
 * Callback function for u_unescapeAt() that returns a character of
 * the source text given an offset and a context pointer.  The context
 * pointer will be whatever is passed into u_unescapeAt().
 *
 * @param offset pointer to the offset that will be passed to u_unescapeAt().
 * @param context an opaque pointer passed directly into u_unescapeAt()
 * @return the character represented by the escape sequence at
 * offset
 * @see u_unescapeAt
 * @stable ICU 2.0
 */
typedef UChar (U_CALLCONV *UNESCAPE_CHAR_AT)(int32_t offset, void *context);
U_CDECL_END

/**
 * Unescape a single sequence. The character at offset-1 is assumed
 * (without checking) to be a backslash.  This method takes a callback
 * pointer to a function that returns the UChar at a given offset.  By
 * varying this callback, ICU functions are able to unescape char*
 * strings, UnicodeString objects, and UFILE pointers.
 *
 * If offset is out of range, or if the escape sequence is ill-formed,
 * (UChar32)0xFFFFFFFF is returned.  See documentation of u_unescape()
 * for a list of recognized sequences.
 *
 * @param charAt callback function that returns a UChar of the source
 * text given an offset and a context pointer.
 * @param offset pointer to the offset that will be passed to charAt.
 * The offset value will be updated upon return to point after the
 * last parsed character of the escape sequence.  On error the offset
 * is unchanged.
 * @param length the number of characters in the source text.  The
 * last character of the source text is considered to be at offset
 * length-1.
 * @param context an opaque pointer passed directly into charAt.
 * @return the character represented by the escape sequence at
 * offset, or (UChar32)0xFFFFFFFF on error.
 * @see u_unescape()
 * @see UnicodeString#unescape()
 * @see UnicodeString#unescapeAt()
 * @stable ICU 2.0
 */
U_CAPI UChar32 U_EXPORT2
u_unescapeAt(UNESCAPE_CHAR_AT charAt,
             int32_t *offset,
             int32_t length,
             void *context);

/**
 * Uppercase the characters in a string.
 * Casing is locale-dependent and context-sensitive.
 * The result may be longer or shorter than the original.
 * The source string and the destination buffer are allowed to overlap.
 *
 * @param dest      A buffer for the result string. The result will be zero-terminated if
 *                  the buffer is large enough.
 * @param destCapacity The size of the buffer (number of UChars). If it is 0, then
 *                  dest may be NULL and the function will only return the length of the result
 *                  without writing any of the result string.
 * @param src       The original string
 * @param srcLength The length of the original string. If -1, then src must be zero-terminated.
 * @param locale    The locale to consider, or "" for the root locale or NULL for the default locale.
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                  which must not indicate a failure before the function call.
 * @return The length of the result string. It may be greater than destCapacity. In that case,
 *         only some of the result was written to the destination buffer.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_strToUpper(UChar *dest, int32_t destCapacity,
             const UChar *src, int32_t srcLength,
             const char *locale,
             UErrorCode *pErrorCode);

/**
 * Lowercase the characters in a string.
 * Casing is locale-dependent and context-sensitive.
 * The result may be longer or shorter than the original.
 * The source string and the destination buffer are allowed to overlap.
 *
 * @param dest      A buffer for the result string. The result will be zero-terminated if
 *                  the buffer is large enough.
 * @param destCapacity The size of the buffer (number of UChars). If it is 0, then
 *                  dest may be NULL and the function will only return the length of the result
 *                  without writing any of the result string.
 * @param src       The original string
 * @param srcLength The length of the original string. If -1, then src must be zero-terminated.
 * @param locale    The locale to consider, or "" for the root locale or NULL for the default locale.
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                  which must not indicate a failure before the function call.
 * @return The length of the result string. It may be greater than destCapacity. In that case,
 *         only some of the result was written to the destination buffer.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_strToLower(UChar *dest, int32_t destCapacity,
             const UChar *src, int32_t srcLength,
             const char *locale,
             UErrorCode *pErrorCode);

#if !UCONFIG_NO_BREAK_ITERATION

/**
 * Titlecase a string.
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
 * The result may be longer or shorter than the original.
 * The source string and the destination buffer are allowed to overlap.
 *
 * @param dest      A buffer for the result string. The result will be zero-terminated if
 *                  the buffer is large enough.
 * @param destCapacity The size of the buffer (number of UChars). If it is 0, then
 *                  dest may be NULL and the function will only return the length of the result
 *                  without writing any of the result string.
 * @param src       The original string
 * @param srcLength The length of the original string. If -1, then src must be zero-terminated.
 * @param titleIter A break iterator to find the first characters of words
 *                  that are to be titlecased.
 *                  If none is provided (NULL), then a standard titlecase
 *                  break iterator is opened.
 * @param locale    The locale to consider, or "" for the root locale or NULL for the default locale.
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                  which must not indicate a failure before the function call.
 * @return The length of the result string. It may be greater than destCapacity. In that case,
 *         only some of the result was written to the destination buffer.
 * @stable ICU 2.1
 */
U_CAPI int32_t U_EXPORT2
u_strToTitle(UChar *dest, int32_t destCapacity,
             const UChar *src, int32_t srcLength,
             UBreakIterator *titleIter,
             const char *locale,
             UErrorCode *pErrorCode);

#endif

/**
 * Case-folds the characters in a string.
 *
 * Case-folding is locale-independent and not context-sensitive,
 * but there is an option for whether to include or exclude mappings for dotted I
 * and dotless i that are marked with 'T' in CaseFolding.txt.
 *
 * The result may be longer or shorter than the original.
 * The source string and the destination buffer are allowed to overlap.
 *
 * @param dest      A buffer for the result string. The result will be zero-terminated if
 *                  the buffer is large enough.
 * @param destCapacity The size of the buffer (number of UChars). If it is 0, then
 *                  dest may be NULL and the function will only return the length of the result
 *                  without writing any of the result string.
 * @param src       The original string
 * @param srcLength The length of the original string. If -1, then src must be zero-terminated.
 * @param options   Either U_FOLD_CASE_DEFAULT or U_FOLD_CASE_EXCLUDE_SPECIAL_I
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                  which must not indicate a failure before the function call.
 * @return The length of the result string. It may be greater than destCapacity. In that case,
 *         only some of the result was written to the destination buffer.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
u_strFoldCase(UChar *dest, int32_t destCapacity,
              const UChar *src, int32_t srcLength,
              uint32_t options,
              UErrorCode *pErrorCode);

#if defined(U_WCHAR_IS_UTF16) || defined(U_WCHAR_IS_UTF32) || !UCONFIG_NO_CONVERSION
/**
 * Convert a UTF-16 string to a wchar_t string.
 * If it is known at compile time that wchar_t strings are in UTF-16 or UTF-32, then
 * this function simply calls the fast, dedicated function for that.
 * Otherwise, two conversions UTF-16 -> default charset -> wchar_t* are performed.
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of wchar_t's). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the 
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If 
 *                      pDestLength!=NULL then *pDestLength is always set to the 
 *                      number of output units corresponding to the transformation of 
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param pErrorCode    Must be a valid pointer to an error code value,
 *                      which must not indicate a failure before the function call.
 * @return The pointer to destination buffer.
 * @stable ICU 2.0
 */
U_CAPI wchar_t* U_EXPORT2
u_strToWCS(wchar_t *dest, 
           int32_t destCapacity,
           int32_t *pDestLength,
           const UChar *src, 
           int32_t srcLength,
           UErrorCode *pErrorCode);
/**
 * Convert a wchar_t string to UTF-16.
 * If it is known at compile time that wchar_t strings are in UTF-16 or UTF-32, then
 * this function simply calls the fast, dedicated function for that.
 * Otherwise, two conversions wchar_t* -> default charset -> UTF-16 are performed.
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of UChars). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the 
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If 
 *                      pDestLength!=NULL then *pDestLength is always set to the 
 *                      number of output units corresponding to the transformation of 
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param pErrorCode    Must be a valid pointer to an error code value,
 *                      which must not indicate a failure before the function call.
 * @return The pointer to destination buffer.
 * @stable ICU 2.0
 */
U_CAPI UChar* U_EXPORT2
u_strFromWCS(UChar   *dest,
             int32_t destCapacity, 
             int32_t *pDestLength,
             const wchar_t *src,
             int32_t srcLength,
             UErrorCode *pErrorCode);
#endif /* defined(U_WCHAR_IS_UTF16) || defined(U_WCHAR_IS_UTF32) || !UCONFIG_NO_CONVERSION */

/**
 * Convert a UTF-16 string to UTF-8.
 * If the input string is not well-formed, then the U_INVALID_CHAR_FOUND error code is set.
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of chars). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the 
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If 
 *                      pDestLength!=NULL then *pDestLength is always set to the 
 *                      number of output units corresponding to the transformation of 
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param pErrorCode    Must be a valid pointer to an error code value,
 *                      which must not indicate a failure before the function call.
 * @return The pointer to destination buffer.
 * @stable ICU 2.0
 * @see u_strToUTF8WithSub
 * @see u_strFromUTF8
 */
U_CAPI char* U_EXPORT2 
u_strToUTF8(char *dest,           
            int32_t destCapacity,
            int32_t *pDestLength,
            const UChar *src, 
            int32_t srcLength,
            UErrorCode *pErrorCode);

/**
 * Convert a UTF-8 string to UTF-16.
 * If the input string is not well-formed, then the U_INVALID_CHAR_FOUND error code is set.
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of UChars). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the 
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If 
 *                      pDestLength!=NULL then *pDestLength is always set to the 
 *                      number of output units corresponding to the transformation of 
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param pErrorCode    Must be a valid pointer to an error code value,
 *                      which must not indicate a failure before the function call.
 * @return The pointer to destination buffer.
 * @stable ICU 2.0
 * @see u_strFromUTF8WithSub
 * @see u_strFromUTF8Lenient
 */
U_CAPI UChar* U_EXPORT2
u_strFromUTF8(UChar *dest,             
              int32_t destCapacity,
              int32_t *pDestLength,
              const char *src, 
              int32_t srcLength,
              UErrorCode *pErrorCode);

/**
 * Convert a UTF-16 string to UTF-8.
 *
 * Same as u_strToUTF8() except for the additional subchar which is output for
 * illegal input sequences, instead of stopping with the U_INVALID_CHAR_FOUND error code.
 * With subchar==U_SENTINEL, this function behaves exactly like u_strToUTF8().
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of chars). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the 
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If 
 *                      pDestLength!=NULL then *pDestLength is always set to the 
 *                      number of output units corresponding to the transformation of 
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param subchar       The substitution character to use in place of an illegal input sequence,
 *                      or U_SENTINEL if the function is to return with U_INVALID_CHAR_FOUND instead.
 *                      A substitution character can be any valid Unicode code point (up to U+10FFFF)
 *                      except for surrogate code points (U+D800..U+DFFF).
 *                      The recommended value is U+FFFD "REPLACEMENT CHARACTER".
 * @param pNumSubstitutions Output parameter receiving the number of substitutions if subchar>=0.
 *                      Set to 0 if no substitutions occur or subchar<0.
 *                      pNumSubstitutions can be NULL.
 * @param pErrorCode    Pointer to a standard ICU error code. Its input value must
 *                      pass the U_SUCCESS() test, or else the function returns
 *                      immediately. Check for U_FAILURE() on output or use with
 *                      function chaining. (See User Guide for details.)
 * @return The pointer to destination buffer.
 * @see u_strToUTF8
 * @see u_strFromUTF8WithSub
 * @stable ICU 3.6
 */
U_CAPI char* U_EXPORT2
u_strToUTF8WithSub(char *dest,
            int32_t destCapacity,
            int32_t *pDestLength,
            const UChar *src,
            int32_t srcLength,
            UChar32 subchar, int32_t *pNumSubstitutions,
            UErrorCode *pErrorCode);

/**
 * Convert a UTF-8 string to UTF-16.
 *
 * Same as u_strFromUTF8() except for the additional subchar which is output for
 * illegal input sequences, instead of stopping with the U_INVALID_CHAR_FOUND error code.
 * With subchar==U_SENTINEL, this function behaves exactly like u_strFromUTF8().
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of UChars). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the 
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If 
 *                      pDestLength!=NULL then *pDestLength is always set to the 
 *                      number of output units corresponding to the transformation of 
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param subchar       The substitution character to use in place of an illegal input sequence,
 *                      or U_SENTINEL if the function is to return with U_INVALID_CHAR_FOUND instead.
 *                      A substitution character can be any valid Unicode code point (up to U+10FFFF)
 *                      except for surrogate code points (U+D800..U+DFFF).
 *                      The recommended value is U+FFFD "REPLACEMENT CHARACTER".
 * @param pNumSubstitutions Output parameter receiving the number of substitutions if subchar>=0.
 *                      Set to 0 if no substitutions occur or subchar<0.
 *                      pNumSubstitutions can be NULL.
 * @param pErrorCode    Pointer to a standard ICU error code. Its input value must
 *                      pass the U_SUCCESS() test, or else the function returns
 *                      immediately. Check for U_FAILURE() on output or use with
 *                      function chaining. (See User Guide for details.)
 * @return The pointer to destination buffer.
 * @see u_strFromUTF8
 * @see u_strFromUTF8Lenient
 * @see u_strToUTF8WithSub
 * @stable ICU 3.6
 */
U_CAPI UChar* U_EXPORT2
u_strFromUTF8WithSub(UChar *dest,
              int32_t destCapacity,
              int32_t *pDestLength,
              const char *src,
              int32_t srcLength,
              UChar32 subchar, int32_t *pNumSubstitutions,
              UErrorCode *pErrorCode);

/**
 * Convert a UTF-8 string to UTF-16.
 *
 * Same as u_strFromUTF8() except that this function is designed to be very fast,
 * which it achieves by being lenient about malformed UTF-8 sequences.
 * This function is intended for use in environments where UTF-8 text is
 * expected to be well-formed.
 *
 * Its semantics are:
 * - Well-formed UTF-8 text is correctly converted to well-formed UTF-16 text.
 * - The function will not read beyond the input string, nor write beyond
 *   the destCapacity.
 * - Malformed UTF-8 results in "garbage" 16-bit Unicode strings which may not
 *   be well-formed UTF-16.
 *   The function will resynchronize to valid code point boundaries
 *   within a small number of code points after an illegal sequence.
 * - Non-shortest forms are not detected and will result in "spoofing" output.
 *
 * For further performance improvement, if srcLength is given (>=0),
 * then it must be destCapacity>=srcLength.
 *
 * There is no inverse u_strToUTF8Lenient() function because there is practically
 * no performance gain from not checking that a UTF-16 string is well-formed.
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of UChars). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the 
 *                      result without writing any of the result string (pre-flighting).
 *                      Unlike for other ICU functions, if srcLength>=0 then it
 *                      must be destCapacity>=srcLength.
 * @param pDestLength   A pointer to receive the number of units written to the destination. If 
 *                      pDestLength!=NULL then *pDestLength is always set to the 
 *                      number of output units corresponding to the transformation of 
 *                      all the input units, even in case of a buffer overflow.
 *                      Unlike for other ICU functions, if srcLength>=0 but
 *                      destCapacity<srcLength, then *pDestLength will be set to srcLength
 *                      (and U_BUFFER_OVERFLOW_ERROR will be set)
 *                      regardless of the actual result length.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param pErrorCode    Pointer to a standard ICU error code. Its input value must
 *                      pass the U_SUCCESS() test, or else the function returns
 *                      immediately. Check for U_FAILURE() on output or use with
 *                      function chaining. (See User Guide for details.)
 * @return The pointer to destination buffer.
 * @see u_strFromUTF8
 * @see u_strFromUTF8WithSub
 * @see u_strToUTF8WithSub
 * @stable ICU 3.6
 */
U_CAPI UChar * U_EXPORT2
u_strFromUTF8Lenient(UChar *dest,
                     int32_t destCapacity,
                     int32_t *pDestLength,
                     const char *src,
                     int32_t srcLength,
                     UErrorCode *pErrorCode);

/**
 * Convert a UTF-16 string to UTF-32.
 * If the input string is not well-formed, then the U_INVALID_CHAR_FOUND error code is set.
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of UChar32s). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the 
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If 
 *                      pDestLength!=NULL then *pDestLength is always set to the 
 *                      number of output units corresponding to the transformation of 
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param pErrorCode    Must be a valid pointer to an error code value,
 *                      which must not indicate a failure before the function call.
 * @return The pointer to destination buffer.
 * @see u_strToUTF32WithSub
 * @see u_strFromUTF32
 * @stable ICU 2.0
 */
U_CAPI UChar32* U_EXPORT2 
u_strToUTF32(UChar32 *dest, 
             int32_t  destCapacity,
             int32_t  *pDestLength,
             const UChar *src, 
             int32_t  srcLength,
             UErrorCode *pErrorCode);

/**
 * Convert a UTF-32 string to UTF-16.
 * If the input string is not well-formed, then the U_INVALID_CHAR_FOUND error code is set.
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of UChars). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the 
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If 
 *                      pDestLength!=NULL then *pDestLength is always set to the 
 *                      number of output units corresponding to the transformation of 
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param pErrorCode    Must be a valid pointer to an error code value,
 *                      which must not indicate a failure before the function call.
 * @return The pointer to destination buffer.
 * @see u_strFromUTF32WithSub
 * @see u_strToUTF32
 * @stable ICU 2.0
 */
U_CAPI UChar* U_EXPORT2 
u_strFromUTF32(UChar   *dest,
               int32_t destCapacity, 
               int32_t *pDestLength,
               const UChar32 *src,
               int32_t srcLength,
               UErrorCode *pErrorCode);

/**
 * Convert a UTF-16 string to UTF-32.
 *
 * Same as u_strToUTF32() except for the additional subchar which is output for
 * illegal input sequences, instead of stopping with the U_INVALID_CHAR_FOUND error code.
 * With subchar==U_SENTINEL, this function behaves exactly like u_strToUTF32().
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of UChar32s). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If
 *                      pDestLength!=NULL then *pDestLength is always set to the
 *                      number of output units corresponding to the transformation of
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param subchar       The substitution character to use in place of an illegal input sequence,
 *                      or U_SENTINEL if the function is to return with U_INVALID_CHAR_FOUND instead.
 *                      A substitution character can be any valid Unicode code point (up to U+10FFFF)
 *                      except for surrogate code points (U+D800..U+DFFF).
 *                      The recommended value is U+FFFD "REPLACEMENT CHARACTER".
 * @param pNumSubstitutions Output parameter receiving the number of substitutions if subchar>=0.
 *                      Set to 0 if no substitutions occur or subchar<0.
 *                      pNumSubstitutions can be NULL.
 * @param pErrorCode    Pointer to a standard ICU error code. Its input value must
 *                      pass the U_SUCCESS() test, or else the function returns
 *                      immediately. Check for U_FAILURE() on output or use with
 *                      function chaining. (See User Guide for details.)
 * @return The pointer to destination buffer.
 * @see u_strToUTF32
 * @see u_strFromUTF32WithSub
 * @stable ICU 4.2
 */
U_CAPI UChar32* U_EXPORT2
u_strToUTF32WithSub(UChar32 *dest,
             int32_t destCapacity,
             int32_t *pDestLength,
             const UChar *src,
             int32_t srcLength,
             UChar32 subchar, int32_t *pNumSubstitutions,
             UErrorCode *pErrorCode);

/**
 * Convert a UTF-32 string to UTF-16.
 *
 * Same as u_strFromUTF32() except for the additional subchar which is output for
 * illegal input sequences, instead of stopping with the U_INVALID_CHAR_FOUND error code.
 * With subchar==U_SENTINEL, this function behaves exactly like u_strFromUTF32().
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of UChars). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If
 *                      pDestLength!=NULL then *pDestLength is always set to the
 *                      number of output units corresponding to the transformation of
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param subchar       The substitution character to use in place of an illegal input sequence,
 *                      or U_SENTINEL if the function is to return with U_INVALID_CHAR_FOUND instead.
 *                      A substitution character can be any valid Unicode code point (up to U+10FFFF)
 *                      except for surrogate code points (U+D800..U+DFFF).
 *                      The recommended value is U+FFFD "REPLACEMENT CHARACTER".
 * @param pNumSubstitutions Output parameter receiving the number of substitutions if subchar>=0.
 *                      Set to 0 if no substitutions occur or subchar<0.
 *                      pNumSubstitutions can be NULL.
 * @param pErrorCode    Pointer to a standard ICU error code. Its input value must
 *                      pass the U_SUCCESS() test, or else the function returns
 *                      immediately. Check for U_FAILURE() on output or use with
 *                      function chaining. (See User Guide for details.)
 * @return The pointer to destination buffer.
 * @see u_strFromUTF32
 * @see u_strToUTF32WithSub
 * @stable ICU 4.2
 */
U_CAPI UChar* U_EXPORT2
u_strFromUTF32WithSub(UChar *dest,
               int32_t destCapacity,
               int32_t *pDestLength,
               const UChar32 *src,
               int32_t srcLength,
               UChar32 subchar, int32_t *pNumSubstitutions,
               UErrorCode *pErrorCode);

/**
 * Convert a 16-bit Unicode string to Java Modified UTF-8.
 * See http://java.sun.com/javase/6/docs/api/java/io/DataInput.html#modified-utf-8
 *
 * This function behaves according to the documentation for Java DataOutput.writeUTF()
 * except that it does not encode the output length in the destination buffer
 * and does not have an output length restriction.
 * See http://java.sun.com/javase/6/docs/api/java/io/DataOutput.html#writeUTF(java.lang.String)
 *
 * The input string need not be well-formed UTF-16.
 * (Therefore there is no subchar parameter.)
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of chars). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the 
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If 
 *                      pDestLength!=NULL then *pDestLength is always set to the 
 *                      number of output units corresponding to the transformation of 
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param pErrorCode    Pointer to a standard ICU error code. Its input value must
 *                      pass the U_SUCCESS() test, or else the function returns
 *                      immediately. Check for U_FAILURE() on output or use with
 *                      function chaining. (See User Guide for details.)
 * @return The pointer to destination buffer.
 * @stable ICU 4.4
 * @see u_strToUTF8WithSub
 * @see u_strFromJavaModifiedUTF8WithSub
 */
U_CAPI char* U_EXPORT2 
u_strToJavaModifiedUTF8(
        char *dest,
        int32_t destCapacity,
        int32_t *pDestLength,
        const UChar *src, 
        int32_t srcLength,
        UErrorCode *pErrorCode);

/**
 * Convert a Java Modified UTF-8 string to a 16-bit Unicode string.
 * If the input string is not well-formed and no substitution char is specified, 
 * then the U_INVALID_CHAR_FOUND error code is set.
 *
 * This function behaves according to the documentation for Java DataInput.readUTF()
 * except that it takes a length parameter rather than
 * interpreting the first two input bytes as the length.
 * See http://java.sun.com/javase/6/docs/api/java/io/DataInput.html#readUTF()
 *
 * The output string may not be well-formed UTF-16.
 *
 * @param dest          A buffer for the result string. The result will be zero-terminated if
 *                      the buffer is large enough.
 * @param destCapacity  The size of the buffer (number of UChars). If it is 0, then
 *                      dest may be NULL and the function will only return the length of the 
 *                      result without writing any of the result string (pre-flighting).
 * @param pDestLength   A pointer to receive the number of units written to the destination. If 
 *                      pDestLength!=NULL then *pDestLength is always set to the 
 *                      number of output units corresponding to the transformation of 
 *                      all the input units, even in case of a buffer overflow.
 * @param src           The original source string
 * @param srcLength     The length of the original string. If -1, then src must be zero-terminated.
 * @param subchar       The substitution character to use in place of an illegal input sequence,
 *                      or U_SENTINEL if the function is to return with U_INVALID_CHAR_FOUND instead.
 *                      A substitution character can be any valid Unicode code point (up to U+10FFFF)
 *                      except for surrogate code points (U+D800..U+DFFF).
 *                      The recommended value is U+FFFD "REPLACEMENT CHARACTER".
 * @param pNumSubstitutions Output parameter receiving the number of substitutions if subchar>=0.
 *                      Set to 0 if no substitutions occur or subchar<0.
 *                      pNumSubstitutions can be NULL.
 * @param pErrorCode    Pointer to a standard ICU error code. Its input value must
 *                      pass the U_SUCCESS() test, or else the function returns
 *                      immediately. Check for U_FAILURE() on output or use with
 *                      function chaining. (See User Guide for details.)
 * @return The pointer to destination buffer.
 * @see u_strFromUTF8WithSub
 * @see u_strFromUTF8Lenient
 * @see u_strToJavaModifiedUTF8
 * @stable ICU 4.4
 */
U_CAPI UChar* U_EXPORT2
u_strFromJavaModifiedUTF8WithSub(
        UChar *dest,
        int32_t destCapacity,
        int32_t *pDestLength,
        const char *src,
        int32_t srcLength,
        UChar32 subchar, int32_t *pNumSubstitutions,
        UErrorCode *pErrorCode);

#endif
