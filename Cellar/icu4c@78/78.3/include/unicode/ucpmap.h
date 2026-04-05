// © 2018 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

// ucpmap.h
// created: 2018sep03 Markus W. Scherer

#ifndef __UCPMAP_H__
#define __UCPMAP_H__

#include "unicode/utypes.h"

U_CDECL_BEGIN

/**
 * \file
 * \brief C API: This file defines an abstract map from Unicode code points to integer values.
 *
 * @see UCPMap
 * @see UCPTrie
 * @see UMutableCPTrie
 */

/**
 * Abstract map from Unicode code points (U+0000..U+10FFFF) to integer values.
 *
 * @see UCPTrie
 * @see UMutableCPTrie
 * @stable ICU 63
 */
typedef struct UCPMap UCPMap;

/**
 * Selectors for how ucpmap_getRange() etc. should report value ranges overlapping with surrogates.
 * Most users should use UCPMAP_RANGE_NORMAL.
 *
 * @see ucpmap_getRange
 * @see ucptrie_getRange
 * @see umutablecptrie_getRange
 * @stable ICU 63
 */
enum UCPMapRangeOption {
    /**
     * ucpmap_getRange() enumerates all same-value ranges as stored in the map.
     * Most users should use this option.
     * @stable ICU 63
     */
    UCPMAP_RANGE_NORMAL,
    /**
     * ucpmap_getRange() enumerates all same-value ranges as stored in the map,
     * except that lead surrogates (U+D800..U+DBFF) are treated as having the
     * surrogateValue, which is passed to getRange() as a separate parameter.
     * The surrogateValue is not transformed via filter().
     * See U_IS_LEAD(c).
     *
     * Most users should use UCPMAP_RANGE_NORMAL instead.
     *
     * This option is useful for maps that map surrogate code *units* to
     * special values optimized for UTF-16 string processing
     * or for special error behavior for unpaired surrogates,
     * but those values are not to be associated with the lead surrogate code *points*.
     * @stable ICU 63
     */
    UCPMAP_RANGE_FIXED_LEAD_SURROGATES,
    /**
     * ucpmap_getRange() enumerates all same-value ranges as stored in the map,
     * except that all surrogates (U+D800..U+DFFF) are treated as having the
     * surrogateValue, which is passed to getRange() as a separate parameter.
     * The surrogateValue is not transformed via filter().
     * See U_IS_SURROGATE(c).
     *
     * Most users should use UCPMAP_RANGE_NORMAL instead.
     *
     * This option is useful for maps that map surrogate code *units* to
     * special values optimized for UTF-16 string processing
     * or for special error behavior for unpaired surrogates,
     * but those values are not to be associated with the lead surrogate code *points*.
     * @stable ICU 63
     */
    UCPMAP_RANGE_FIXED_ALL_SURROGATES
};
#ifndef U_IN_DOXYGEN
typedef enum UCPMapRangeOption UCPMapRangeOption;
#endif

/**
 * Returns the value for a code point as stored in the map, with range checking.
 * Returns an implementation-defined error value if c is not in the range 0..U+10FFFF.
 *
 * @param map the map
 * @param c the code point
 * @return the map value,
 *         or an implementation-defined error value if the code point is not in the range 0..U+10FFFF
 * @stable ICU 63
 */
U_CAPI uint32_t U_EXPORT2
ucpmap_get(const UCPMap *map, UChar32 c);

/**
 * Callback function type: Modifies a map value.
 * Optionally called by ucpmap_getRange()/ucptrie_getRange()/umutablecptrie_getRange().
 * The modified value will be returned by the getRange function.
 *
 * Can be used to ignore some of the value bits,
 * make a filter for one of several values,
 * return a value index computed from the map value, etc.
 *
 * @param context an opaque pointer, as passed into the getRange function
 * @param value a value from the map
 * @return the modified value
 * @stable ICU 63
 */
typedef uint32_t U_CALLCONV
UCPMapValueFilter(const void *context, uint32_t value);

/**
 * Returns the last code point such that all those from start to there have the same value.
 * Can be used to efficiently iterate over all same-value ranges in a map.
 * (This is normally faster than iterating over code points and get()ting each value,
 * but much slower than a data structure that stores ranges directly.)
 *
 * If the UCPMapValueFilter function pointer is not NULL, then
 * the value to be delivered is passed through that function, and the return value is the end
 * of the range where all values are modified to the same actual value.
 * The value is unchanged if that function pointer is NULL.
 *
 * Example:
 * \code
 * UChar32 start = 0, end;
 * uint32_t value;
 * while ((end = ucpmap_getRange(map, start, UCPMAP_RANGE_NORMAL, 0,
 *                               NULL, NULL, &value)) >= 0) {
 *     // Work with the range start..end and its value.
 *     start = end + 1;
 * }
 * \endcode
 *
 * @param map the map
 * @param start range start
 * @param option defines whether surrogates are treated normally,
 *               or as having the surrogateValue; usually UCPMAP_RANGE_NORMAL
 * @param surrogateValue value for surrogates; ignored if option==UCPMAP_RANGE_NORMAL
 * @param filter a pointer to a function that may modify the map data value,
 *     or NULL if the values from the map are to be used unmodified
 * @param context an opaque pointer that is passed on to the filter function
 * @param pValue if not NULL, receives the value that every code point start..end has;
 *     may have been modified by filter(context, map value)
 *     if that function pointer is not NULL
 * @return the range end code point, or -1 if start is not a valid code point
 * @stable ICU 63
 */
U_CAPI UChar32 U_EXPORT2
ucpmap_getRange(const UCPMap *map, UChar32 start,
                UCPMapRangeOption option, uint32_t surrogateValue,
                UCPMapValueFilter *filter, const void *context, uint32_t *pValue);

U_CDECL_END

#endif
