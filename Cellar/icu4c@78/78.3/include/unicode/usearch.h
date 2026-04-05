// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 2001-2011,2014 IBM and others. All rights reserved.
**********************************************************************
*   Date        Name        Description
*  06/28/2001   synwee      Creation.
**********************************************************************
*/
#ifndef USEARCH_H
#define USEARCH_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_COLLATION && !UCONFIG_NO_BREAK_ITERATION

#include "unicode/ucol.h"
#include "unicode/ucoleitr.h"
#include "unicode/ubrk.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C API: StringSearch
 *
 * C APIs for an engine that provides language-sensitive text searching based 
 * on the comparison rules defined in a <code>UCollator</code> data struct,
 * see <code>ucol.h</code>. This ensures that language eccentricity can be 
 * handled, e.g. for the German collator, characters &szlig; and SS will be matched 
 * if case is chosen to be ignored. 
 * See the <a href="https://htmlpreview.github.io/?https://github.com/unicode-org/icu-docs/blob/main/design/collation/ICU_collation_design.htm">
 * "ICU Collation Design Document"</a> for more information.
 * <p> 
 * As of ICU4C 4.0 / ICU4J 53, the implementation uses a linear search. In previous versions,
 * a modified form of the Boyer-Moore searching algorithm was used. For more information
 * on the modified Boyer-Moore algorithm see
 * <a href="http://icu-project.org/docs/papers/efficient_text_searching_in_java.html">
 * "Efficient Text Searching in Java"</a>, published in <i>Java Report</i> 
 * in February, 1999.
 * <p>
 * There are 2 match options for selection:<br>
 * Let S' be the sub-string of a text string S between the offsets start and 
 * end <start, end>.
 * <br>
 * A pattern string P matches a text string S at the offsets <start, end> 
 * if
 * <pre> 
 * option 1. Some canonical equivalent of P matches some canonical equivalent 
 *           of S'
 * option 2. P matches S' and if P starts or ends with a combining mark, 
 *           there exists no non-ignorable combining mark before or after S' 
 *           in S respectively. 
 * </pre>
 * Option 2. will be the default.
 * <p>
 * This search has APIs similar to that of other text iteration mechanisms 
 * such as the break iterators in <code>ubrk.h</code>. Using these 
 * APIs, it is easy to scan through text looking for all occurrences of 
 * a given pattern. This search iterator allows changing of direction by 
 * calling a <code>reset</code> followed by a <code>next</code> or <code>previous</code>. 
 * Though a direction change can occur without calling <code>reset</code> first,  
 * this operation comes with some speed penalty.
 * Generally, match results in the forward direction will match the result 
 * matches in the backwards direction in the reverse order
 * <p>
 * <code>usearch.h</code> provides APIs to specify the starting position 
 * within the text string to be searched, e.g. <code>usearch_setOffset</code>,
 * <code>usearch_preceding</code> and <code>usearch_following</code>. Since the 
 * starting position will be set as it is specified, please take note that 
 * there are some dangerous positions which the search may render incorrect 
 * results:
 * <ul>
 * <li> The midst of a substring that requires normalization.
 * <li> If the following match is to be found, the position should not be the
 *      second character which requires to be swapped with the preceding 
 *      character. Vice versa, if the preceding match is to be found, 
 *      position to search from should not be the first character which 
 *      requires to be swapped with the next character. E.g certain Thai and
 *      Lao characters require swapping.
 * <li> If a following pattern match is to be found, any position within a 
 *      contracting sequence except the first will fail. Vice versa if a 
 *      preceding pattern match is to be found, a invalid starting point 
 *      would be any character within a contracting sequence except the last.
 * </ul>
 * <p>
 * A breakiterator can be used if only matches at logical breaks are desired.
 * Using a breakiterator will only give you results that exactly matches the
 * boundaries given by the breakiterator. For instance the pattern "e" will
 * not be found in the string "\u00e9" if a character break iterator is used.
 * <p>
 * Options are provided to handle overlapping matches. 
 * E.g. In English, overlapping matches produces the result 0 and 2 
 * for the pattern "abab" in the text "ababab", where else mutually 
 * exclusive matches only produce the result of 0.
 * <p>
 * Options are also provided to implement "asymmetric search" as described in
 * <a href="http://www.unicode.org/reports/tr10/#Asymmetric_Search">
 * UTS #10 Unicode Collation Algorithm</a>, specifically the USearchAttribute
 * USEARCH_ELEMENT_COMPARISON and its values.
 * <p>
 * Though collator attributes will be taken into consideration while 
 * performing matches, there are no APIs here for setting and getting the 
 * attributes. These attributes can be set by getting the collator
 * from <code>usearch_getCollator</code> and using the APIs in <code>ucol.h</code>.
 * Lastly to update String Search to the new collator attributes, 
 * usearch_reset() has to be called.
 * <p> 
 * Restriction: <br>
 * Currently there are no composite characters that consists of a
 * character with combining class > 0 before a character with combining 
 * class == 0. However, if such a character exists in the future, the 
 * search mechanism does not guarantee the results for option 1.
 * 
 * <p>
 * Example of use:<br>
 * <pre><code>
 * char *tgtstr = "The quick brown fox jumped over the lazy fox";
 * char *patstr = "fox";
 * UChar target[64];
 * UChar pattern[16];
 * UErrorCode status = U_ZERO_ERROR;
 * u_uastrcpy(target, tgtstr);
 * u_uastrcpy(pattern, patstr);
 *
 * UStringSearch *search = usearch_open(pattern, -1, target, -1, "en_US", 
 *                                  NULL, &status);
 * if (U_SUCCESS(status)) {
 *     for (int pos = usearch_first(search, &status); 
 *          pos != USEARCH_DONE; 
 *          pos = usearch_next(search, &status))
 *     {
 *         printf("Found match at %d pos, length is %d\n", pos, 
 *                                        usearch_getMatchedLength(search));
 *     }
 * }
 *
 * usearch_close(search);
 * </code></pre>
 * @stable ICU 2.4
 */

/**
* DONE is returned by previous() and next() after all valid matches have 
* been returned, and by first() and last() if there are no matches at all.
* @stable ICU 2.4
*/
#define USEARCH_DONE -1

/**
* Data structure for searching
* @stable ICU 2.4
*/
struct UStringSearch;
/**
* Data structure for searching
* @stable ICU 2.4
*/
typedef struct UStringSearch UStringSearch;

/**
* @stable ICU 2.4
*/
typedef enum {
    /**
     * Option for overlapping matches
     * @stable ICU 2.4
     */
    USEARCH_OVERLAP = 0,
#ifndef U_HIDE_DEPRECATED_API
    /** 
     * Option for canonical matches; option 1 in header documentation.
     * The default value will be USEARCH_OFF.
     * Note: Setting this option to USEARCH_ON currently has no effect on
     * search behavior, and this option is deprecated. Instead, to control
     * canonical match behavior, you must set UCOL_NORMALIZATION_MODE
     * appropriately (to UCOL_OFF or UCOL_ON) in the UCollator used by
     * the UStringSearch object.
     * @see usearch_openFromCollator 
     * @see usearch_getCollator
     * @see usearch_setCollator
     * @see ucol_getAttribute
     * @deprecated ICU 53
     */
    USEARCH_CANONICAL_MATCH = 1,
#endif  /* U_HIDE_DEPRECATED_API */
    /** 
     * Option to control how collation elements are compared.
     * The default value will be USEARCH_STANDARD_ELEMENT_COMPARISON.
     * @stable ICU 4.4
     */
    USEARCH_ELEMENT_COMPARISON = 2,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal USearchAttribute value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    USEARCH_ATTRIBUTE_COUNT = 3
#endif  /* U_HIDE_DEPRECATED_API */
} USearchAttribute;

/**
* @stable ICU 2.4
*/
typedef enum {
    /** 
     * Default value for any USearchAttribute
     * @stable ICU 2.4
     */
    USEARCH_DEFAULT = -1,
    /**
     * Value for USEARCH_OVERLAP and USEARCH_CANONICAL_MATCH
     * @stable ICU 2.4
     */
    USEARCH_OFF, 
    /**
     * Value for USEARCH_OVERLAP and USEARCH_CANONICAL_MATCH
     * @stable ICU 2.4
     */
    USEARCH_ON,
    /** 
     * Value (default) for USEARCH_ELEMENT_COMPARISON;
     * standard collation element comparison at the specified collator
     * strength.
     * @stable ICU 4.4
     */
    USEARCH_STANDARD_ELEMENT_COMPARISON,
    /** 
     * Value for USEARCH_ELEMENT_COMPARISON;
     * collation element comparison is modified to effectively provide
     * behavior between the specified strength and strength - 1. Collation
     * elements in the pattern that have the base weight for the specified
     * strength are treated as "wildcards" that match an element with any
     * other weight at that collation level in the searched text. For
     * example, with a secondary-strength English collator, a plain 'e' in
     * the pattern will match a plain e or an e with any diacritic in the
     * searched text, but an e with diacritic in the pattern will only
     * match an e with the same diacritic in the searched text.
     *
     * This supports "asymmetric search" as described in
     * <a href="http://www.unicode.org/reports/tr10/#Asymmetric_Search">
     * UTS #10 Unicode Collation Algorithm</a>.
     *
     * @stable ICU 4.4
     */
    USEARCH_PATTERN_BASE_WEIGHT_IS_WILDCARD,
    /** 
     * Value for USEARCH_ELEMENT_COMPARISON.
     * collation element comparison is modified to effectively provide
     * behavior between the specified strength and strength - 1. Collation
     * elements in either the pattern or the searched text that have the
     * base weight for the specified strength are treated as "wildcards"
     * that match an element with any other weight at that collation level.
     * For example, with a secondary-strength English collator, a plain 'e'
     * in the pattern will match a plain e or an e with any diacritic in the
     * searched text, but an e with diacritic in the pattern will only
     * match an e with the same diacritic or a plain e in the searched text.
     *
     * This option is similar to "asymmetric search" as described in
     * [UTS #10 Unicode Collation Algorithm](http://www.unicode.org/reports/tr10/#Asymmetric_Search),
     * but also allows unmarked characters in the searched text to match
     * marked or unmarked versions of that character in the pattern.
     *
     * @stable ICU 4.4
     */
    USEARCH_ANY_BASE_WEIGHT_IS_WILDCARD,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal USearchAttributeValue value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    USEARCH_ATTRIBUTE_VALUE_COUNT
#endif  /* U_HIDE_DEPRECATED_API */
} USearchAttributeValue;

/* open and close ------------------------------------------------------ */

/**
* Creates a String Search iterator data struct using the argument locale language
* rule set. A collator will be created in the process, which will be owned by
* this String Search and will be deleted in <code>usearch_close</code>.
*
* The UStringSearch retains a pointer to both the pattern and text strings.
* The caller must not modify or delete them while using the UStringSearch.
*
* @param pattern for matching
* @param patternlength length of the pattern, -1 for null-termination
* @param text text string
* @param textlength length of the text string, -1 for null-termination
* @param locale name of locale for the rules to be used
* @param breakiter A BreakIterator that will be used to restrict the points
*                  at which matches are detected. If a match is found, but 
*                  the match's start or end index is not a boundary as 
*                  determined by the <code>BreakIterator</code>, the match will 
*                  be rejected and another will be searched for. 
*                  If this parameter is <code>NULL</code>, no break detection is 
*                  attempted.
* @param status for errors if it occurs. If pattern or text is NULL, or if
*               patternlength or textlength is 0 then an 
*               U_ILLEGAL_ARGUMENT_ERROR is returned.
* @return search iterator data structure, or NULL if there is an error.
* @stable ICU 2.4
*/
U_CAPI UStringSearch * U_EXPORT2 usearch_open(const UChar    *pattern,
                                              int32_t         patternlength,
                                        const UChar          *text,
                                              int32_t         textlength,
                                        const char           *locale,
                                              UBreakIterator *breakiter,
                                              UErrorCode     *status);

/**
* Creates a String Search iterator data struct using the argument collator language
* rule set. Note, user retains the ownership of this collator, thus the
* responsibility of deletion lies with the user.

* NOTE: String Search cannot be instantiated from a collator that has
* collate digits as numbers (CODAN) turned on (UCOL_NUMERIC_COLLATION).
*
* The UStringSearch retains a pointer to both the pattern and text strings.
* The caller must not modify or delete them while using the UStringSearch.
*
* @param pattern for matching
* @param patternlength length of the pattern, -1 for null-termination
* @param text text string
* @param textlength length of the text string, -1 for null-termination
* @param collator used for the language rules
* @param breakiter A BreakIterator that will be used to restrict the points
*                  at which matches are detected. If a match is found, but
*                  the match's start or end index is not a boundary as
*                  determined by the <code>BreakIterator</code>, the match will
*                  be rejected and another will be searched for.
*                  If this parameter is <code>NULL</code>, no break detection is
*                  attempted.
* @param status for errors if it occurs. If collator, pattern or text is NULL,
*               or if patternlength or textlength is 0 then an
*               U_ILLEGAL_ARGUMENT_ERROR is returned.
* @return search iterator data structure, or NULL if there is an error.
* @stable ICU 2.4
*/
U_CAPI UStringSearch * U_EXPORT2 usearch_openFromCollator(
                                         const UChar          *pattern,
                                               int32_t         patternlength,
                                         const UChar          *text,
                                               int32_t         textlength,
                                         const UCollator      *collator,
                                               UBreakIterator *breakiter,
                                               UErrorCode     *status);

/**
 * Destroys and cleans up the String Search iterator data struct.
 * If a collator was created in <code>usearch_open</code>, then it will be destroyed here.
 * @param searchiter The UStringSearch to clean up
 * @stable ICU 2.4
 */
U_CAPI void U_EXPORT2 usearch_close(UStringSearch *searchiter);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUStringSearchPointer
 * "Smart pointer" class, closes a UStringSearch via usearch_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUStringSearchPointer, UStringSearch, usearch_close);

U_NAMESPACE_END

#endif

/* get and set methods -------------------------------------------------- */

/**
* Sets the current position in the text string which the next search will 
* start from. Clears previous states. 
* This method takes the argument index and sets the position in the text 
* string accordingly without checking if the index is pointing to a 
* valid starting point to begin searching. 
* Search positions that may render incorrect results are highlighted in the
* header comments
* @param strsrch search iterator data struct
* @param position position to start next search from. If position is less
*          than or greater than the text range for searching, 
*          an U_INDEX_OUTOFBOUNDS_ERROR will be returned
* @param status error status if any.
* @stable ICU 2.4
*/
U_CAPI void U_EXPORT2 usearch_setOffset(UStringSearch *strsrch,
                                        int32_t        position,
                                        UErrorCode    *status);

/**
* Return the current index in the string text being searched.
* If the iteration has gone past the end of the text (or past the beginning 
* for a backwards search), <code>USEARCH_DONE</code> is returned.
* @param strsrch search iterator data struct
* @see #USEARCH_DONE
* @stable ICU 2.4
*/
U_CAPI int32_t U_EXPORT2 usearch_getOffset(const UStringSearch *strsrch);
    
/**
* Sets the text searching attributes located in the enum USearchAttribute
* with values from the enum USearchAttributeValue.
* <code>USEARCH_DEFAULT</code> can be used for all attributes for resetting.
* @param strsrch search iterator data struct
* @param attribute text attribute to be set
* @param value text attribute value
* @param status for errors if it occurs
* @see #usearch_getAttribute
* @stable ICU 2.4
*/
U_CAPI void U_EXPORT2 usearch_setAttribute(UStringSearch         *strsrch,
                                           USearchAttribute       attribute,
                                           USearchAttributeValue  value,
                                           UErrorCode            *status);

/**    
* Gets the text searching attributes.
* @param strsrch search iterator data struct
* @param attribute text attribute to be retrieve
* @return text attribute value
* @see #usearch_setAttribute
* @stable ICU 2.4
*/
U_CAPI USearchAttributeValue U_EXPORT2 usearch_getAttribute(
                                         const UStringSearch    *strsrch,
                                               USearchAttribute  attribute);

/**
* Returns the index to the match in the text string that was searched.
* This call returns a valid result only after a successful call to 
* <code>usearch_first</code>, <code>usearch_next</code>, <code>usearch_previous</code>, 
* or <code>usearch_last</code>.
* Just after construction, or after a searching method returns 
* <code>USEARCH_DONE</code>, this method will return <code>USEARCH_DONE</code>.
* <p>
* Use <code>usearch_getMatchedLength</code> to get the matched string length.
* @param strsrch search iterator data struct
* @return index to a substring within the text string that is being 
*         searched.
* @see #usearch_first
* @see #usearch_next
* @see #usearch_previous
* @see #usearch_last
* @see #USEARCH_DONE
* @stable ICU 2.4
*/
U_CAPI int32_t U_EXPORT2 usearch_getMatchedStart(
                                               const UStringSearch *strsrch);
    
/**
* Returns the length of text in the string which matches the search pattern. 
* This call returns a valid result only after a successful call to 
* <code>usearch_first</code>, <code>usearch_next</code>, <code>usearch_previous</code>, 
* or <code>usearch_last</code>.
* Just after construction, or after a searching method returns 
* <code>USEARCH_DONE</code>, this method will return 0.
* @param strsrch search iterator data struct
* @return The length of the match in the string text, or 0 if there is no 
*         match currently.
* @see #usearch_first
* @see #usearch_next
* @see #usearch_previous
* @see #usearch_last
* @see #USEARCH_DONE
* @stable ICU 2.4
*/
U_CAPI int32_t U_EXPORT2 usearch_getMatchedLength(
                                               const UStringSearch *strsrch);

/**
* Returns the text that was matched by the most recent call to 
* <code>usearch_first</code>, <code>usearch_next</code>, <code>usearch_previous</code>, 
* or <code>usearch_last</code>.
* If the iterator is not pointing at a valid match (e.g. just after 
* construction or after <code>USEARCH_DONE</code> has been returned, returns
* an empty string. If result is not large enough to store the matched text,
* result will be filled with the partial text and an U_BUFFER_OVERFLOW_ERROR 
* will be returned in status. result will be null-terminated whenever 
* possible. If the buffer fits the matched text exactly, a null-termination 
* is not possible, then a U_STRING_NOT_TERMINATED_ERROR set in status.
* Pre-flighting can be either done with length = 0 or the API 
* <code>usearch_getMatchedLength</code>.
* @param strsrch search iterator data struct
* @param result UChar buffer to store the matched string
* @param resultCapacity length of the result buffer
* @param status error returned if result is not large enough
* @return exact length of the matched text, not counting the null-termination
* @see #usearch_first
* @see #usearch_next
* @see #usearch_previous
* @see #usearch_last
* @see #USEARCH_DONE
* @stable ICU 2.4
*/
U_CAPI int32_t U_EXPORT2 usearch_getMatchedText(const UStringSearch *strsrch, 
                                            UChar         *result, 
                                            int32_t        resultCapacity, 
                                            UErrorCode    *status);

#if !UCONFIG_NO_BREAK_ITERATION

/**
* Set the BreakIterator that will be used to restrict the points at which 
* matches are detected.
* @param strsrch search iterator data struct
* @param breakiter A BreakIterator that will be used to restrict the points
*                  at which matches are detected. If a match is found, but 
*                  the match's start or end index is not a boundary as 
*                  determined by the <code>BreakIterator</code>, the match will 
*                  be rejected and another will be searched for. 
*                  If this parameter is <code>NULL</code>, no break detection is 
*                  attempted.
* @param status for errors if it occurs
* @see #usearch_getBreakIterator
* @stable ICU 2.4
*/
U_CAPI void U_EXPORT2 usearch_setBreakIterator(UStringSearch  *strsrch, 
                                               UBreakIterator *breakiter,
                                               UErrorCode     *status);

/**
* Returns the BreakIterator that is used to restrict the points at which 
* matches are detected. This will be the same object that was passed to the 
* constructor or to <code>usearch_setBreakIterator</code>. Note that 
* <code>NULL</code> 
* is a legal value; it means that break detection should not be attempted.
* @param strsrch search iterator data struct
* @return break iterator used
* @see #usearch_setBreakIterator
* @stable ICU 2.4
*/
U_CAPI const UBreakIterator * U_EXPORT2 usearch_getBreakIterator(
                                              const UStringSearch *strsrch);
    
#endif

/**
* Set the string text to be searched. Text iteration will hence begin at the 
* start of the text string. This method is useful if you want to re-use an 
* iterator to search for the same pattern within a different body of text.
*
* The UStringSearch retains a pointer to the text string. The caller must not
* modify or delete the string while using the UStringSearch.
*
* @param strsrch search iterator data struct
* @param text new string to look for match
* @param textlength length of the new string, -1 for null-termination
* @param status for errors if it occurs. If text is NULL, or textlength is 0 
*               then an U_ILLEGAL_ARGUMENT_ERROR is returned with no change
*               done to strsrch.
* @see #usearch_getText
* @stable ICU 2.4
*/
U_CAPI void U_EXPORT2 usearch_setText(      UStringSearch *strsrch, 
                                      const UChar         *text,
                                            int32_t        textlength,
                                            UErrorCode    *status);

/**
* Return the string text to be searched.
* @param strsrch search iterator data struct
* @param length returned string text length
* @return string text 
* @see #usearch_setText
* @stable ICU 2.4
*/
U_CAPI const UChar * U_EXPORT2 usearch_getText(const UStringSearch *strsrch, 
                                               int32_t       *length);

/**
* Gets the collator used for the language rules. 
* <p>
* Deleting the returned <code>UCollator</code> before calling 
* <code>usearch_close</code> would cause the string search to fail.
* <code>usearch_close</code> will delete the collator if this search owns it.
* @param strsrch search iterator data struct
* @return collator
* @stable ICU 2.4
*/
U_CAPI UCollator * U_EXPORT2 usearch_getCollator(
                                               const UStringSearch *strsrch);

/**
* Sets the collator used for the language rules. User retains the ownership 
* of this collator, thus the responsibility of deletion lies with the user.
* This method causes internal data such as the pattern collation elements
* and shift tables to be recalculated, but the iterator's position is unchanged.
* @param strsrch search iterator data struct
* @param collator to be used
* @param status for errors if it occurs
* @stable ICU 2.4
*/
U_CAPI void U_EXPORT2 usearch_setCollator(      UStringSearch *strsrch, 
                                          const UCollator     *collator,
                                                UErrorCode    *status);

/**
* Sets the pattern used for matching.
* Internal data like the pattern collation elements will be recalculated, but the 
* iterator's position is unchanged.
*
* The UStringSearch retains a pointer to the pattern string. The caller must not
* modify or delete the string while using the UStringSearch.
*
* @param strsrch search iterator data struct
* @param pattern string
* @param patternlength pattern length, -1 for null-terminated string
* @param status for errors if it occurs. If text is NULL, or textlength is 0 
*               then an U_ILLEGAL_ARGUMENT_ERROR is returned with no change
*               done to strsrch.
* @stable ICU 2.4
*/
U_CAPI void U_EXPORT2 usearch_setPattern(      UStringSearch *strsrch, 
                                         const UChar         *pattern,
                                               int32_t        patternlength,
                                               UErrorCode    *status);

/**
* Gets the search pattern
* @param strsrch search iterator data struct
* @param length return length of the pattern, -1 indicates that the pattern 
*               is null-terminated
* @return pattern string
* @stable ICU 2.4
*/
U_CAPI const UChar * U_EXPORT2 usearch_getPattern(
                                               const UStringSearch *strsrch, 
                                                     int32_t       *length);

/* methods ------------------------------------------------------------- */

/**
* Returns the first index at which the string text matches the search 
* pattern.  
* The iterator is adjusted so that its current index (as returned by 
* <code>usearch_getOffset</code>) is the match position if one was found.
* If a match is not found, <code>USEARCH_DONE</code> will be returned and
* the iterator will be adjusted to the index <code>USEARCH_DONE</code>.
* @param strsrch search iterator data struct
* @param status for errors if it occurs
* @return The character index of the first match, or 
* <code>USEARCH_DONE</code> if there are no matches.
* @see #usearch_getOffset
* @see #USEARCH_DONE
* @stable ICU 2.4
*/
U_CAPI int32_t U_EXPORT2 usearch_first(UStringSearch *strsrch, 
                                           UErrorCode    *status);

/**
* Returns the first index equal or greater than <code>position</code> at which
* the string text
* matches the search pattern. The iterator is adjusted so that its current 
* index (as returned by <code>usearch_getOffset</code>) is the match position if 
* one was found.
* If a match is not found, <code>USEARCH_DONE</code> will be returned and
* the iterator will be adjusted to the index <code>USEARCH_DONE</code>
* <p>
* Search positions that may render incorrect results are highlighted in the
* header comments. If position is less than or greater than the text range 
* for searching, an U_INDEX_OUTOFBOUNDS_ERROR will be returned
* @param strsrch search iterator data struct
* @param position to start the search at
* @param status for errors if it occurs
* @return The character index of the first match following <code>pos</code>,
*         or <code>USEARCH_DONE</code> if there are no matches.
* @see #usearch_getOffset
* @see #USEARCH_DONE
* @stable ICU 2.4
*/
U_CAPI int32_t U_EXPORT2 usearch_following(UStringSearch *strsrch, 
                                               int32_t    position, 
                                               UErrorCode    *status);
    
/**
* Returns the last index in the target text at which it matches the search 
* pattern. The iterator is adjusted so that its current 
* index (as returned by <code>usearch_getOffset</code>) is the match position if 
* one was found.
* If a match is not found, <code>USEARCH_DONE</code> will be returned and
* the iterator will be adjusted to the index <code>USEARCH_DONE</code>.
* @param strsrch search iterator data struct
* @param status for errors if it occurs
* @return The index of the first match, or <code>USEARCH_DONE</code> if there 
*         are no matches.
* @see #usearch_getOffset
* @see #USEARCH_DONE
* @stable ICU 2.4
*/
U_CAPI int32_t U_EXPORT2 usearch_last(UStringSearch *strsrch, 
                                          UErrorCode    *status);

/**
* Returns the first index less than <code>position</code> at which the string text 
* matches the search pattern. The iterator is adjusted so that its current 
* index (as returned by <code>usearch_getOffset</code>) is the match position if 
* one was found.
* If a match is not found, <code>USEARCH_DONE</code> will be returned and
* the iterator will be adjusted to the index <code>USEARCH_DONE</code>
* <p>
* Search positions that may render incorrect results are highlighted in the
* header comments. If position is less than or greater than the text range 
* for searching, an U_INDEX_OUTOFBOUNDS_ERROR will be returned.
* <p>
* When <code>USEARCH_OVERLAP</code> option is off, the last index of the
* result match is always less than <code>position</code>.
* When <code>USERARCH_OVERLAP</code> is on, the result match may span across
* <code>position</code>.
* @param strsrch search iterator data struct
* @param position index position the search is to begin at
* @param status for errors if it occurs
* @return The character index of the first match preceding <code>pos</code>,
*         or <code>USEARCH_DONE</code> if there are no matches.
* @see #usearch_getOffset
* @see #USEARCH_DONE
* @stable ICU 2.4
*/
U_CAPI int32_t U_EXPORT2 usearch_preceding(UStringSearch *strsrch, 
                                               int32_t    position, 
                                               UErrorCode    *status);
    
/**
* Returns the index of the next point at which the string text matches the
* search pattern, starting from the current position.
* The iterator is adjusted so that its current 
* index (as returned by <code>usearch_getOffset</code>) is the match position if 
* one was found.
* If a match is not found, <code>USEARCH_DONE</code> will be returned and
* the iterator will be adjusted to the index <code>USEARCH_DONE</code>
* @param strsrch search iterator data struct
* @param status for errors if it occurs
* @return The index of the next match after the current position, or 
*         <code>USEARCH_DONE</code> if there are no more matches.
* @see #usearch_first
* @see #usearch_getOffset
* @see #USEARCH_DONE
* @stable ICU 2.4
*/
U_CAPI int32_t U_EXPORT2 usearch_next(UStringSearch *strsrch, 
                                          UErrorCode    *status);

/**
* Returns the index of the previous point at which the string text matches
* the search pattern, starting at the current position.
* The iterator is adjusted so that its current 
* index (as returned by <code>usearch_getOffset</code>) is the match position if 
* one was found.
* If a match is not found, <code>USEARCH_DONE</code> will be returned and
* the iterator will be adjusted to the index <code>USEARCH_DONE</code>
* @param strsrch search iterator data struct
* @param status for errors if it occurs
* @return The index of the previous match before the current position,
*         or <code>USEARCH_DONE</code> if there are no more matches.
* @see #usearch_last
* @see #usearch_getOffset
* @see #USEARCH_DONE
* @stable ICU 2.4
*/
U_CAPI int32_t U_EXPORT2 usearch_previous(UStringSearch *strsrch, 
                                              UErrorCode    *status);
    
/** 
* Reset the iteration.
* Search will begin at the start of the text string if a forward iteration 
* is initiated before a backwards iteration. Otherwise if a backwards 
* iteration is initiated before a forwards iteration, the search will begin
* at the end of the text string.
* @param strsrch search iterator data struct
* @see #usearch_first
* @stable ICU 2.4
*/
U_CAPI void U_EXPORT2 usearch_reset(UStringSearch *strsrch);

#ifndef U_HIDE_INTERNAL_API
/**
  *  Simple forward search for the pattern, starting at a specified index,
  *     and using a default set search options.
  *
  *  This is an experimental function, and is not an official part of the
  *      ICU API.
  *
  *  The collator options, such as UCOL_STRENGTH and UCOL_NORMALIZTION, are honored.
  *
  *  The UStringSearch options USEARCH_CANONICAL_MATCH, USEARCH_OVERLAP and
  *  any Break Iterator are ignored.
  *
  *  Matches obey the following constraints:
  *
  *      Characters at the start or end positions of a match that are ignorable
  *      for collation are not included as part of the match, unless they
  *      are part of a combining sequence, as described below.
  *
  *      A match will not include a partial combining sequence.  Combining
  *      character sequences  are considered to be  inseparable units,
  *      and either match the pattern completely, or are considered to not match
  *      at all.  Thus, for example, an A followed a combining accent mark will 
  *      not be found when searching for a plain (unaccented) A.   (unless
  *      the collation strength has been set to ignore all accents).
  *
  *      When beginning a search, the initial starting position, startIdx,
  *      is assumed to be an acceptable match boundary with respect to
  *      combining characters.  A combining sequence that spans across the
  *      starting point will not suppress a match beginning at startIdx.
  *
  *      Characters that expand to multiple collation elements
  *      (German sharp-S becoming 'ss', or the composed forms of accented
  *      characters, for example) also must match completely.
  *      Searching for a single 's' in a string containing only a sharp-s will 
  *      find no match.
  *
  *
  *  @param strsrch    the UStringSearch struct, which references both
  *                    the text to be searched  and the pattern being sought.
  *  @param startIdx   The index into the text to begin the search.
  *  @param matchStart An out parameter, the starting index of the matched text.
  *                    This parameter may be NULL.
  *                    A value of -1 will be returned if no match was found.
  *  @param matchLimit Out parameter, the index of the first position following the matched text.
  *                    The matchLimit will be at a suitable position for beginning a subsequent search
  *                    in the input text.
  *                    This parameter may be NULL.
  *                    A value of -1 will be returned if no match was found.
  *          
  *  @param status     Report any errors.  Note that no match found is not an error.
  *  @return           true if a match was found, false otherwise.
  *
  *  @internal
  */
U_CAPI UBool U_EXPORT2 usearch_search(UStringSearch *strsrch,
                                          int32_t        startIdx,
                                          int32_t        *matchStart,
                                          int32_t        *matchLimit,
                                          UErrorCode     *status);

/**
  *  Simple backwards search for the pattern, starting at a specified index,
  *     and using using a default set search options.
  *
  *  This is an experimental function, and is not an official part of the
  *      ICU API.
  *
  *  The collator options, such as UCOL_STRENGTH and UCOL_NORMALIZTION, are honored.
  *
  *  The UStringSearch options USEARCH_CANONICAL_MATCH, USEARCH_OVERLAP and
  *  any Break Iterator are ignored.
  *
  *  Matches obey the following constraints:
  *
  *      Characters at the start or end positions of a match that are ignorable
  *      for collation are not included as part of the match, unless they
  *      are part of a combining sequence, as described below.
  *
  *      A match will not include a partial combining sequence.  Combining
  *      character sequences  are considered to be  inseparable units,
  *      and either match the pattern completely, or are considered to not match
  *      at all.  Thus, for example, an A followed a combining accent mark will 
  *      not be found when searching for a plain (unaccented) A.   (unless
  *      the collation strength has been set to ignore all accents).
  *
  *      When beginning a search, the initial starting position, startIdx,
  *      is assumed to be an acceptable match boundary with respect to
  *      combining characters.  A combining sequence that spans across the
  *      starting point will not suppress a match beginning at startIdx.
  *
  *      Characters that expand to multiple collation elements
  *      (German sharp-S becoming 'ss', or the composed forms of accented
  *      characters, for example) also must match completely.
  *      Searching for a single 's' in a string containing only a sharp-s will 
  *      find no match.
  *
  *
  *  @param strsrch    the UStringSearch struct, which references both
  *                    the text to be searched  and the pattern being sought.
  *  @param startIdx   The index into the text to begin the search.
  *  @param matchStart An out parameter, the starting index of the matched text.
  *                    This parameter may be NULL.
  *                    A value of -1 will be returned if no match was found.
  *  @param matchLimit Out parameter, the index of the first position following the matched text.
  *                    The matchLimit will be at a suitable position for beginning a subsequent search
  *                    in the input text.
  *                    This parameter may be NULL.
  *                    A value of -1 will be returned if no match was found.
  *          
  *  @param status     Report any errors.  Note that no match found is not an error.
  *  @return           true if a match was found, false otherwise.
  *
  *  @internal
  */
U_CAPI UBool U_EXPORT2 usearch_searchBackwards(UStringSearch *strsrch,
                                                   int32_t        startIdx,
                                                   int32_t        *matchStart,
                                                   int32_t        *matchLimit,
                                                   UErrorCode     *status);
#endif  /* U_HIDE_INTERNAL_API */

#endif /* #if !UCONFIG_NO_COLLATION  && !UCONFIG_NO_BREAK_ITERATION */

#endif
