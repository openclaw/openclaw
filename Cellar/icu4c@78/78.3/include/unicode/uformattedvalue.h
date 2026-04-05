// © 2018 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#ifndef __UFORMATTEDVALUE_H__
#define __UFORMATTEDVALUE_H__

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#include "unicode/ufieldpositer.h"

/**
 * \file
 * \brief C API: Abstract operations for localized strings.
 * 
 * This file contains declarations for classes that deal with formatted strings. A number
 * of APIs throughout ICU use these classes for expressing their localized output.
 */


/**
 * All possible field categories in ICU. Every entry in this enum corresponds
 * to another enum that exists in ICU.
 * 
 * In the APIs that take a UFieldCategory, an int32_t type is used. Field
 * categories having any of the top four bits turned on are reserved as
 * private-use for external APIs implementing FormattedValue. This means that
 * categories 2^28 and higher or below zero (with the highest bit turned on)
 * are private-use and will not be used by ICU in the future.
 *
 * @stable ICU 64
 */
typedef enum UFieldCategory {
    /**
     * For an undefined field category.
     * 
     * @stable ICU 64
     */
    UFIELD_CATEGORY_UNDEFINED = 0,

    /**
     * For fields in UDateFormatField (udat.h), from ICU 3.0.
     *
     * @stable ICU 64
     */
    UFIELD_CATEGORY_DATE,

    /**
     * For fields in UNumberFormatFields (unum.h), from ICU 49.
     *
     * @stable ICU 64
     */
    UFIELD_CATEGORY_NUMBER,

    /**
     * For fields in UListFormatterField (ulistformatter.h), from ICU 63.
     *
     * @stable ICU 64
     */
    UFIELD_CATEGORY_LIST,

    /**
     * For fields in URelativeDateTimeFormatterField (ureldatefmt.h), from ICU 64.
     *
     * @stable ICU 64
     */
    UFIELD_CATEGORY_RELATIVE_DATETIME,

    /**
     * Reserved for possible future fields in UDateIntervalFormatField.
     *
     * @internal
     */
    UFIELD_CATEGORY_DATE_INTERVAL,

#ifndef U_HIDE_INTERNAL_API
    /** @internal */
    UFIELD_CATEGORY_COUNT,
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Category for spans in a list.
     *
     * @stable ICU 64
     */
    UFIELD_CATEGORY_LIST_SPAN = 0x1000 + UFIELD_CATEGORY_LIST,

    /**
     * Category for spans in a date interval.
     *
     * @stable ICU 64
     */
    UFIELD_CATEGORY_DATE_INTERVAL_SPAN = 0x1000 + UFIELD_CATEGORY_DATE_INTERVAL,

    /**
     * Category for spans in a number range.
     *
     * @stable ICU 69
     */
    UFIELD_CATEGORY_NUMBER_RANGE_SPAN = 0x1000 + UFIELD_CATEGORY_NUMBER,

} UFieldCategory;


struct UConstrainedFieldPosition;
/**
 * Represents a span of a string containing a given field.
 *
 * This struct differs from UFieldPosition in the following ways:
 *
 *   1. It has information on the field category.
 *   2. It allows you to set constraints to use when iterating over field positions.
 *   3. It is used for the newer FormattedValue APIs.
 *
 * @stable ICU 64
 */
typedef struct UConstrainedFieldPosition UConstrainedFieldPosition;


/**
 * Creates a new UConstrainedFieldPosition.
 *
 * By default, the UConstrainedFieldPosition has no iteration constraints.
 *
 * @param ec Set if an error occurs.
 * @return The new object, or NULL if an error occurs.
 * @stable ICU 64
 */
U_CAPI UConstrainedFieldPosition* U_EXPORT2
ucfpos_open(UErrorCode* ec);


/**
 * Resets a UConstrainedFieldPosition to its initial state, as if it were newly created.
 *
 * Removes any constraints that may have been set on the instance.
 *
 * @param ucfpos The instance of UConstrainedFieldPosition.
 * @param ec Set if an error occurs.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ucfpos_reset(
    UConstrainedFieldPosition* ucfpos,
    UErrorCode* ec);


/**
 * Destroys a UConstrainedFieldPosition and releases its memory.
 *
 * @param ucfpos The instance of UConstrainedFieldPosition.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ucfpos_close(UConstrainedFieldPosition* ucfpos);


/**
 * Sets a constraint on the field category.
 * 
 * When this instance of UConstrainedFieldPosition is passed to ufmtval_nextPosition,
 * positions are skipped unless they have the given category.
 *
 * Any previously set constraints are cleared.
 *
 * For example, to loop over only the number-related fields:
 *
 *     UConstrainedFieldPosition* ucfpos = ucfpos_open(ec);
 *     ucfpos_constrainCategory(ucfpos, UFIELDCATEGORY_NUMBER_FORMAT, ec);
 *     while (ufmtval_nextPosition(ufmtval, ucfpos, ec)) {
 *         // handle the number-related field position
 *     }
 *     ucfpos_close(ucfpos);
 *
 * Changing the constraint while in the middle of iterating over a FormattedValue
 * does not generally have well-defined behavior.
 *
 * @param ucfpos The instance of UConstrainedFieldPosition.
 * @param category The field category to fix when iterating.
 * @param ec Set if an error occurs.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ucfpos_constrainCategory(
    UConstrainedFieldPosition* ucfpos,
    int32_t category,
    UErrorCode* ec);


/**
 * Sets a constraint on the category and field.
 * 
 * When this instance of UConstrainedFieldPosition is passed to ufmtval_nextPosition,
 * positions are skipped unless they have the given category and field.
 *
 * Any previously set constraints are cleared.
 *
 * For example, to loop over all grouping separators:
 *
 *     UConstrainedFieldPosition* ucfpos = ucfpos_open(ec);
 *     ucfpos_constrainField(ucfpos, UFIELDCATEGORY_NUMBER_FORMAT, UNUM_GROUPING_SEPARATOR_FIELD, ec);
 *     while (ufmtval_nextPosition(ufmtval, ucfpos, ec)) {
 *         // handle the grouping separator position
 *     }
 *     ucfpos_close(ucfpos);
 *
 * Changing the constraint while in the middle of iterating over a FormattedValue
 * does not generally have well-defined behavior.
 *
 * @param ucfpos The instance of UConstrainedFieldPosition.
 * @param category The field category to fix when iterating.
 * @param field The field to fix when iterating.
 * @param ec Set if an error occurs.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ucfpos_constrainField(
    UConstrainedFieldPosition* ucfpos,
    int32_t category,
    int32_t field,
    UErrorCode* ec);


/**
 * Gets the field category for the current position.
 *
 * If a category or field constraint was set, this function returns the constrained
 * category. Otherwise, the return value is well-defined only after
 * ufmtval_nextPosition returns true.
 *
 * @param ucfpos The instance of UConstrainedFieldPosition.
 * @param ec Set if an error occurs.
 * @return The field category saved in the instance.
 * @stable ICU 64
 */
U_CAPI int32_t U_EXPORT2
ucfpos_getCategory(
    const UConstrainedFieldPosition* ucfpos,
    UErrorCode* ec);


/**
 * Gets the field for the current position.
 *
 * If a field constraint was set, this function returns the constrained
 * field. Otherwise, the return value is well-defined only after
 * ufmtval_nextPosition returns true.
 *
 * @param ucfpos The instance of UConstrainedFieldPosition.
 * @param ec Set if an error occurs.
 * @return The field saved in the instance.
 * @stable ICU 64
 */
U_CAPI int32_t U_EXPORT2
ucfpos_getField(
    const UConstrainedFieldPosition* ucfpos,
    UErrorCode* ec);


/**
 * Gets the INCLUSIVE start and EXCLUSIVE end index stored for the current position.
 *
 * The output values are well-defined only after ufmtval_nextPosition returns true.
 *
 * @param ucfpos The instance of UConstrainedFieldPosition.
 * @param pStart Set to the start index saved in the instance. Ignored if nullptr.
 * @param pLimit Set to the end index saved in the instance. Ignored if nullptr.
 * @param ec Set if an error occurs.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ucfpos_getIndexes(
    const UConstrainedFieldPosition* ucfpos,
    int32_t* pStart,
    int32_t* pLimit,
    UErrorCode* ec);


/**
 * Gets an int64 that FormattedValue implementations may use for storage.
 *
 * The initial value is zero.
 *
 * Users of FormattedValue should not need to call this method.
 *
 * @param ucfpos The instance of UConstrainedFieldPosition.
 * @param ec Set if an error occurs.
 * @return The current iteration context from ucfpos_setInt64IterationContext.
 * @stable ICU 64
 */
U_CAPI int64_t U_EXPORT2
ucfpos_getInt64IterationContext(
    const UConstrainedFieldPosition* ucfpos,
    UErrorCode* ec);


/**
 * Sets an int64 that FormattedValue implementations may use for storage.
 *
 * Intended to be used by FormattedValue implementations.
 *
 * @param ucfpos The instance of UConstrainedFieldPosition.
 * @param context The new iteration context.
 * @param ec Set if an error occurs.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ucfpos_setInt64IterationContext(
    UConstrainedFieldPosition* ucfpos,
    int64_t context,
    UErrorCode* ec);


/**
 * Determines whether a given field should be included given the
 * constraints.
 *
 * Intended to be used by FormattedValue implementations.
 *
 * @param ucfpos The instance of UConstrainedFieldPosition.
 * @param category The category to test.
 * @param field The field to test.
 * @param ec Set if an error occurs.
 * @stable ICU 64
 */
U_CAPI UBool U_EXPORT2
ucfpos_matchesField(
    const UConstrainedFieldPosition* ucfpos,
    int32_t category,
    int32_t field,
    UErrorCode* ec);


/**
 * Sets new values for the primary public getters.
 *
 * Intended to be used by FormattedValue implementations.
 *
 * It is up to the implementation to ensure that the user-requested
 * constraints are satisfied. This method does not check!
 *
 * @param ucfpos The instance of UConstrainedFieldPosition.
 * @param category The new field category.
 * @param field The new field.
 * @param start The new inclusive start index.
 * @param limit The new exclusive end index.
 * @param ec Set if an error occurs.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ucfpos_setState(
    UConstrainedFieldPosition* ucfpos,
    int32_t category,
    int32_t field,
    int32_t start,
    int32_t limit,
    UErrorCode* ec);


struct UFormattedValue;
/**
 * An abstract formatted value: a string with associated field attributes.
 * Many formatters format to types compatible with UFormattedValue.
 *
 * @stable ICU 64
 */
typedef struct UFormattedValue UFormattedValue;


/**
 * Returns a pointer to the formatted string. The pointer is owned by the UFormattedValue. The
 * return value is valid only as long as the UFormattedValue is present and unchanged in memory.
 *
 * The return value is NUL-terminated but could contain internal NULs.
 *
 * @param ufmtval
 *         The object containing the formatted string and attributes.
 * @param pLength Output variable for the length of the string. Ignored if NULL.
 * @param ec Set if an error occurs.
 * @return A NUL-terminated char16 string owned by the UFormattedValue.
 * @stable ICU 64
 */
U_CAPI const UChar* U_EXPORT2
ufmtval_getString(
    const UFormattedValue* ufmtval,
    int32_t* pLength,
    UErrorCode* ec);


/**
 * Iterates over field positions in the UFormattedValue. This lets you determine the position
 * of specific types of substrings, like a month or a decimal separator.
 *
 * To loop over all field positions:
 *
 *     UConstrainedFieldPosition* ucfpos = ucfpos_open(ec);
 *     while (ufmtval_nextPosition(ufmtval, ucfpos, ec)) {
 *         // handle the field position; get information from ucfpos
 *     }
 *     ucfpos_close(ucfpos);
 *
 * @param ufmtval
 *         The object containing the formatted string and attributes.
 * @param ucfpos
 *         The object used for iteration state; can provide constraints to iterate over only
 *         one specific category or field;
 *         see ucfpos_constrainCategory
 *         and ucfpos_constrainField.
 * @param ec Set if an error occurs.
 * @return true if another position was found; false otherwise.
 * @stable ICU 64
 */
U_CAPI UBool U_EXPORT2
ufmtval_nextPosition(
    const UFormattedValue* ufmtval,
    UConstrainedFieldPosition* ucfpos,
    UErrorCode* ec);


#if U_SHOW_CPLUSPLUS_API
U_NAMESPACE_BEGIN

/**
 * \class LocalUConstrainedFieldPositionPointer
 * "Smart pointer" class; closes a UConstrainedFieldPosition via ucfpos_close().
 * For most methods see the LocalPointerBase base class.
 *
 * Usage:
 *
 *     LocalUConstrainedFieldPositionPointer ucfpos(ucfpos_open(ec));
 *     // no need to explicitly call ucfpos_close()
 *
 * @stable ICU 64
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUConstrainedFieldPositionPointer,
    UConstrainedFieldPosition,
    ucfpos_close);

U_NAMESPACE_END
#endif // U_SHOW_CPLUSPLUS_API


#endif /* #if !UCONFIG_NO_FORMATTING */
#endif // __UFORMATTEDVALUE_H__
