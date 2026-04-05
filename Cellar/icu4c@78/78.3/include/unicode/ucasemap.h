// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*
*   Copyright (C) 2005-2012, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
*******************************************************************************
*   file name:  ucasemap.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2005may06
*   created by: Markus W. Scherer
*
*   Case mapping service object and functions using it.
*/

#ifndef __UCASEMAP_H__
#define __UCASEMAP_H__

#include "unicode/utypes.h"
#include "unicode/stringoptions.h"
#include "unicode/ustring.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C API: Unicode case mapping functions using a UCaseMap service object.
 *
 * The service object takes care of memory allocations, data loading, and setup
 * for the attributes, as usual.
 *
 * Currently, the functionality provided here does not overlap with uchar.h
 * and ustring.h, except for ucasemap_toTitle().
 *
 * ucasemap_utf8XYZ() functions operate directly on UTF-8 strings.
 */

/**
 * UCaseMap is an opaque service object for newer ICU case mapping functions.
 * Older functions did not use a service object.
 * @stable ICU 3.4
 */
struct UCaseMap;
typedef struct UCaseMap UCaseMap; /**< C typedef for struct UCaseMap. @stable ICU 3.4 */

/**
 * Open a UCaseMap service object for a locale and a set of options.
 * The locale ID and options are preprocessed so that functions using the
 * service object need not process them in each call.
 *
 * @param locale ICU locale ID, used for language-dependent
 *               upper-/lower-/title-casing according to the Unicode standard.
 *               Usual semantics: ""=root, NULL=default locale, etc.
 * @param options Options bit set, used for case folding and string comparisons.
 *                Same flags as for u_foldCase(), u_strFoldCase(),
 *                u_strCaseCompare(), etc.
 *                Use 0 or U_FOLD_CASE_DEFAULT for default behavior.
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                   which must not indicate a failure before the function call.
 * @return Pointer to a UCaseMap service object, if successful.
 *
 * @see U_FOLD_CASE_DEFAULT
 * @see U_FOLD_CASE_EXCLUDE_SPECIAL_I
 * @see U_TITLECASE_NO_LOWERCASE
 * @see U_TITLECASE_NO_BREAK_ADJUSTMENT
 * @stable ICU 3.4
 */
U_CAPI UCaseMap * U_EXPORT2
ucasemap_open(const char *locale, uint32_t options, UErrorCode *pErrorCode);

/**
 * Close a UCaseMap service object.
 * @param csm Object to be closed.
 * @stable ICU 3.4
 */
U_CAPI void U_EXPORT2
ucasemap_close(UCaseMap *csm);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUCaseMapPointer
 * "Smart pointer" class, closes a UCaseMap via ucasemap_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUCaseMapPointer, UCaseMap, ucasemap_close);

U_NAMESPACE_END

#endif

/**
 * Get the locale ID that is used for language-dependent case mappings.
 * @param csm UCaseMap service object.
 * @return locale ID
 * @stable ICU 3.4
 */
U_CAPI const char * U_EXPORT2
ucasemap_getLocale(const UCaseMap *csm);

/**
 * Get the options bit set that is used for case folding and string comparisons.
 * @param csm UCaseMap service object.
 * @return options bit set
 * @stable ICU 3.4
 */
U_CAPI uint32_t U_EXPORT2
ucasemap_getOptions(const UCaseMap *csm);

/**
 * Set the locale ID that is used for language-dependent case mappings.
 *
 * @param csm UCaseMap service object.
 * @param locale Locale ID, see ucasemap_open().
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                   which must not indicate a failure before the function call.
 *
 * @see ucasemap_open
 * @stable ICU 3.4
 */
U_CAPI void U_EXPORT2
ucasemap_setLocale(UCaseMap *csm, const char *locale, UErrorCode *pErrorCode);

/**
 * Set the options bit set that is used for case folding and string comparisons.
 *
 * @param csm UCaseMap service object.
 * @param options Options bit set, see ucasemap_open().
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                   which must not indicate a failure before the function call.
 *
 * @see ucasemap_open
 * @stable ICU 3.4
 */
U_CAPI void U_EXPORT2
ucasemap_setOptions(UCaseMap *csm, uint32_t options, UErrorCode *pErrorCode);

#if !UCONFIG_NO_BREAK_ITERATION

/**
 * Get the break iterator that is used for titlecasing.
 * Do not modify the returned break iterator.
 * @param csm UCaseMap service object.
 * @return titlecasing break iterator
 * @stable ICU 3.8
 */
U_CAPI const UBreakIterator * U_EXPORT2
ucasemap_getBreakIterator(const UCaseMap *csm);

/**
 * Set the break iterator that is used for titlecasing.
 * The UCaseMap service object releases a previously set break iterator
 * and "adopts" this new one, taking ownership of it.
 * It will be released in a subsequent call to ucasemap_setBreakIterator()
 * or ucasemap_close().
 *
 * Break iterator operations are not thread-safe. Therefore, titlecasing
 * functions use non-const UCaseMap objects. It is not possible to titlecase
 * strings concurrently using the same UCaseMap.
 *
 * @param csm UCaseMap service object.
 * @param iterToAdopt Break iterator to be adopted for titlecasing.
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                   which must not indicate a failure before the function call.
 *
 * @see ucasemap_toTitle
 * @see ucasemap_utf8ToTitle
 * @stable ICU 3.8
 */
U_CAPI void U_EXPORT2
ucasemap_setBreakIterator(UCaseMap *csm, UBreakIterator *iterToAdopt, UErrorCode *pErrorCode);

/**
 * Titlecase a UTF-16 string. This function is almost a duplicate of u_strToTitle(),
 * except that it takes ucasemap_setOptions() into account and has performance
 * advantages from being able to use a UCaseMap object for multiple case mapping
 * operations, saving setup time.
 *
 * Casing is locale-dependent and context-sensitive.
 * Titlecasing uses a break iterator to find the first characters of words
 * that are to be titlecased. It titlecases those characters and lowercases
 * all others. (This can be modified with ucasemap_setOptions().)
 *
 * Note: This function takes a non-const UCaseMap pointer because it will
 * open a default break iterator if no break iterator was set yet,
 * and effectively call ucasemap_setBreakIterator();
 * also because the break iterator is stateful and will be modified during
 * the iteration.
 *
 * The titlecase break iterator can be provided to customize for arbitrary
 * styles, using rules and dictionaries beyond the standard iterators.
 * If the break iterator passed in is null, the default Unicode algorithm
 * will be used to determine the titlecase positions.
 *
 * This function uses only the setText(), first() and next() methods of the
 * provided break iterator.
 *
 * The result may be longer or shorter than the original.
 * The source string and the destination buffer must not overlap.
 *
 * @param csm       UCaseMap service object. This pointer is non-const!
 *                  See the note above for details.
 * @param dest      A buffer for the result string. The result will be NUL-terminated if
 *                  the buffer is large enough.
 *                  The contents is undefined in case of failure.
 * @param destCapacity The size of the buffer (number of UChars). If it is 0, then
 *                  dest may be NULL and the function will only return the length of the result
 *                  without writing any of the result string.
 * @param src       The original string.
 * @param srcLength The length of the original string. If -1, then src must be NUL-terminated.
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                  which must not indicate a failure before the function call.
 * @return The length of the result string, if successful - or in case of a buffer overflow,
 *         in which case it will be greater than destCapacity.
 *
 * @see u_strToTitle
 * @stable ICU 3.8
 */
U_CAPI int32_t U_EXPORT2
ucasemap_toTitle(UCaseMap *csm,
                 UChar *dest, int32_t destCapacity,
                 const UChar *src, int32_t srcLength,
                 UErrorCode *pErrorCode);

#endif  // UCONFIG_NO_BREAK_ITERATION

/**
 * Lowercase the characters in a UTF-8 string.
 * Casing is locale-dependent and context-sensitive.
 * The result may be longer or shorter than the original.
 * The source string and the destination buffer must not overlap.
 *
 * @param csm       UCaseMap service object.
 * @param dest      A buffer for the result string. The result will be NUL-terminated if
 *                  the buffer is large enough.
 *                  The contents is undefined in case of failure.
 * @param destCapacity The size of the buffer (number of bytes). If it is 0, then
 *                  dest may be NULL and the function will only return the length of the result
 *                  without writing any of the result string.
 * @param src       The original string.
 * @param srcLength The length of the original string. If -1, then src must be NUL-terminated.
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                  which must not indicate a failure before the function call.
 * @return The length of the result string, if successful - or in case of a buffer overflow,
 *         in which case it will be greater than destCapacity.
 *
 * @see u_strToLower
 * @stable ICU 3.4
 */
U_CAPI int32_t U_EXPORT2
ucasemap_utf8ToLower(const UCaseMap *csm,
                     char *dest, int32_t destCapacity,
                     const char *src, int32_t srcLength,
                     UErrorCode *pErrorCode);

/**
 * Uppercase the characters in a UTF-8 string.
 * Casing is locale-dependent and context-sensitive.
 * The result may be longer or shorter than the original.
 * The source string and the destination buffer must not overlap.
 *
 * @param csm       UCaseMap service object.
 * @param dest      A buffer for the result string. The result will be NUL-terminated if
 *                  the buffer is large enough.
 *                  The contents is undefined in case of failure.
 * @param destCapacity The size of the buffer (number of bytes). If it is 0, then
 *                  dest may be NULL and the function will only return the length of the result
 *                  without writing any of the result string.
 * @param src       The original string.
 * @param srcLength The length of the original string. If -1, then src must be NUL-terminated.
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                  which must not indicate a failure before the function call.
 * @return The length of the result string, if successful - or in case of a buffer overflow,
 *         in which case it will be greater than destCapacity.
 *
 * @see u_strToUpper
 * @stable ICU 3.4
 */
U_CAPI int32_t U_EXPORT2
ucasemap_utf8ToUpper(const UCaseMap *csm,
                     char *dest, int32_t destCapacity,
                     const char *src, int32_t srcLength,
                     UErrorCode *pErrorCode);

#if !UCONFIG_NO_BREAK_ITERATION

/**
 * Titlecase a UTF-8 string.
 * Casing is locale-dependent and context-sensitive.
 * Titlecasing uses a break iterator to find the first characters of words
 * that are to be titlecased. It titlecases those characters and lowercases
 * all others. (This can be modified with ucasemap_setOptions().)
 *
 * Note: This function takes a non-const UCaseMap pointer because it will
 * open a default break iterator if no break iterator was set yet,
 * and effectively call ucasemap_setBreakIterator();
 * also because the break iterator is stateful and will be modified during
 * the iteration.
 *
 * The titlecase break iterator can be provided to customize for arbitrary
 * styles, using rules and dictionaries beyond the standard iterators.
 * If the break iterator passed in is null, the default Unicode algorithm
 * will be used to determine the titlecase positions.
 *
 * This function uses only the setUText(), first(), next() and close() methods of the
 * provided break iterator.
 *
 * The result may be longer or shorter than the original.
 * The source string and the destination buffer must not overlap.
 *
 * @param csm       UCaseMap service object. This pointer is non-const!
 *                  See the note above for details.
 * @param dest      A buffer for the result string. The result will be NUL-terminated if
 *                  the buffer is large enough.
 *                  The contents is undefined in case of failure.
 * @param destCapacity The size of the buffer (number of bytes). If it is 0, then
 *                  dest may be NULL and the function will only return the length of the result
 *                  without writing any of the result string.
 * @param src       The original string.
 * @param srcLength The length of the original string. If -1, then src must be NUL-terminated.
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                  which must not indicate a failure before the function call.
 * @return The length of the result string, if successful - or in case of a buffer overflow,
 *         in which case it will be greater than destCapacity.
 *
 * @see u_strToTitle
 * @see U_TITLECASE_NO_LOWERCASE
 * @see U_TITLECASE_NO_BREAK_ADJUSTMENT
 * @stable ICU 3.8
 */
U_CAPI int32_t U_EXPORT2
ucasemap_utf8ToTitle(UCaseMap *csm,
                    char *dest, int32_t destCapacity,
                    const char *src, int32_t srcLength,
                    UErrorCode *pErrorCode);

#endif

/**
 * Case-folds the characters in a UTF-8 string.
 *
 * Case-folding is locale-independent and not context-sensitive,
 * but there is an option for whether to include or exclude mappings for dotted I
 * and dotless i that are marked with 'T' in CaseFolding.txt.
 *
 * The result may be longer or shorter than the original.
 * The source string and the destination buffer must not overlap.
 *
 * @param csm       UCaseMap service object.
 * @param dest      A buffer for the result string. The result will be NUL-terminated if
 *                  the buffer is large enough.
 *                  The contents is undefined in case of failure.
 * @param destCapacity The size of the buffer (number of bytes). If it is 0, then
 *                  dest may be NULL and the function will only return the length of the result
 *                  without writing any of the result string.
 * @param src       The original string.
 * @param srcLength The length of the original string. If -1, then src must be NUL-terminated.
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                  which must not indicate a failure before the function call.
 * @return The length of the result string, if successful - or in case of a buffer overflow,
 *         in which case it will be greater than destCapacity.
 *
 * @see u_strFoldCase
 * @see ucasemap_setOptions
 * @see U_FOLD_CASE_DEFAULT
 * @see U_FOLD_CASE_EXCLUDE_SPECIAL_I
 * @stable ICU 3.8
 */
U_CAPI int32_t U_EXPORT2
ucasemap_utf8FoldCase(const UCaseMap *csm,
                      char *dest, int32_t destCapacity,
                      const char *src, int32_t srcLength,
                      UErrorCode *pErrorCode);

#endif
