// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*****************************************************************************************
* Copyright (C) 2016, International Business Machines
* Corporation and others. All Rights Reserved.
*****************************************************************************************
*/

#ifndef URELDATEFMT_H
#define URELDATEFMT_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#include "unicode/unum.h"
#include "unicode/udisplaycontext.h"
#include "unicode/uformattedvalue.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C API: URelativeDateTimeFormatter, relative date formatting of unit + numeric offset.
 *
 * Provides simple formatting of relative dates, in two ways
 * <ul>
 *   <li>relative dates with a quantity e.g "in 5 days"</li>
 *   <li>relative dates without a quantity e.g "next Tuesday"</li>
 * </ul>
 * <p>
 * This does not provide compound formatting for multiple units,
 * other than the ability to combine a time string with a relative date,
 * as in "next Tuesday at 3:45 PM". It also does not provide support
 * for determining which unit to use, such as deciding between "in 7 days"
 * and "in 1 week".
 *
 * @stable ICU 57
 */

/**
 * The formatting style
 * @stable ICU 54
 */
typedef enum UDateRelativeDateTimeFormatterStyle {
  /**
   * Everything spelled out.
   * @stable ICU 54
   */
  UDAT_STYLE_LONG,

  /**
   * Abbreviations used when possible.
   * @stable ICU 54
   */
  UDAT_STYLE_SHORT,

  /**
   * Use the shortest possible form.
   * @stable ICU 54
   */
  UDAT_STYLE_NARROW,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UDateRelativeDateTimeFormatterStyle value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UDAT_STYLE_COUNT
#endif  /* U_HIDE_DEPRECATED_API */
} UDateRelativeDateTimeFormatterStyle;

/**
 * Represents the unit for formatting a relative date. e.g "in 5 days"
 * or "next year"
 * @stable ICU 57
 */
typedef enum URelativeDateTimeUnit {
    /**
     * Specifies that relative unit is year, e.g. "last year",
     * "in 5 years". 
     * @stable ICU 57
     */
    UDAT_REL_UNIT_YEAR,
    /**
     * Specifies that relative unit is quarter, e.g. "last quarter",
     * "in 5 quarters".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_QUARTER,
    /**
     * Specifies that relative unit is month, e.g. "last month",
     * "in 5 months".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_MONTH,
    /**
     * Specifies that relative unit is week, e.g. "last week",
     * "in 5 weeks".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_WEEK,
    /**
     * Specifies that relative unit is day, e.g. "yesterday",
     * "in 5 days".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_DAY,
    /**
     * Specifies that relative unit is hour, e.g. "1 hour ago",
     * "in 5 hours".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_HOUR,
    /**
     * Specifies that relative unit is minute, e.g. "1 minute ago",
     * "in 5 minutes".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_MINUTE,
    /**
     * Specifies that relative unit is second, e.g. "1 second ago",
     * "in 5 seconds".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_SECOND,
    /**
     * Specifies that relative unit is Sunday, e.g. "last Sunday",
     * "this Sunday", "next Sunday", "in 5 Sundays".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_SUNDAY,
    /**
     * Specifies that relative unit is Monday, e.g. "last Monday",
     * "this Monday", "next Monday", "in 5 Mondays".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_MONDAY,
    /**
     * Specifies that relative unit is Tuesday, e.g. "last Tuesday",
     * "this Tuesday", "next Tuesday", "in 5 Tuesdays".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_TUESDAY,
    /**
     * Specifies that relative unit is Wednesday, e.g. "last Wednesday",
     * "this Wednesday", "next Wednesday", "in 5 Wednesdays".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_WEDNESDAY,
    /**
     * Specifies that relative unit is Thursday, e.g. "last Thursday",
     * "this Thursday", "next Thursday", "in 5 Thursdays". 
     * @stable ICU 57
     */
    UDAT_REL_UNIT_THURSDAY,
    /**
     * Specifies that relative unit is Friday, e.g. "last Friday",
     * "this Friday", "next Friday", "in 5 Fridays".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_FRIDAY,
    /**
     * Specifies that relative unit is Saturday, e.g. "last Saturday",
     * "this Saturday", "next Saturday", "in 5 Saturdays".
     * @stable ICU 57
     */
    UDAT_REL_UNIT_SATURDAY,
#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal URelativeDateTimeUnit value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UDAT_REL_UNIT_COUNT
#endif  /* U_HIDE_DEPRECATED_API */
} URelativeDateTimeUnit;

/**
 * FieldPosition and UFieldPosition selectors for format fields
 * defined by RelativeDateTimeFormatter.
 * @stable ICU 64
 */
typedef enum URelativeDateTimeFormatterField {
    /**
     * Represents a literal text string, like "tomorrow" or "days ago".
     * @stable ICU 64
     */
    UDAT_REL_LITERAL_FIELD,
    /**
     * Represents a number quantity, like "3" in "3 days ago".
     * @stable ICU 64
     */
    UDAT_REL_NUMERIC_FIELD,
} URelativeDateTimeFormatterField;


/**
 * Opaque URelativeDateTimeFormatter object for use in C programs.
 * @stable ICU 57
 */
struct URelativeDateTimeFormatter;
typedef struct URelativeDateTimeFormatter URelativeDateTimeFormatter;  /**< C typedef for struct URelativeDateTimeFormatter. @stable ICU 57 */


/**
 * Open a new URelativeDateTimeFormatter object for a given locale using the
 * specified width and capitalizationContext, along with a number formatter
 * (if desired) to override the default formatter that would be used for
 * display of numeric field offsets. The default formatter typically rounds
 * toward 0 and has a minimum of 0 fraction digits and a maximum of 3
 * fraction digits (i.e. it will show as many decimal places as necessary
 * up to 3, without showing trailing 0s).
 *
 * @param locale
 *          The locale
 * @param nfToAdopt
 *          A number formatter to set for this URelativeDateTimeFormatter
 *          object (instead of the default decimal formatter). Ownership of
 *          this UNumberFormat object will pass to the URelativeDateTimeFormatter
 *          object (the URelativeDateTimeFormatter adopts the UNumberFormat),
 *          which becomes responsible for closing it. If the caller wishes to
 *          retain ownership of the UNumberFormat object, the caller must clone
 *          it (with unum_clone) and pass the clone to ureldatefmt_open. May be
 *          NULL to use the default decimal formatter.
 * @param width
 *          The width - wide, short, narrow, etc.
 * @param capitalizationContext
 *          A value from UDisplayContext that pertains to capitalization, e.g.
 *          UDISPCTX_CAPITALIZATION_FOR_BEGINNING_OF_SENTENCE.
 * @param status
 *          A pointer to a UErrorCode to receive any errors.
 * @return
 *          A pointer to a URelativeDateTimeFormatter object for the specified locale,
 *          or NULL if an error occurred.
 * @stable ICU 57
 */
U_CAPI URelativeDateTimeFormatter* U_EXPORT2
ureldatefmt_open( const char*          locale,
                  UNumberFormat*       nfToAdopt,
                  UDateRelativeDateTimeFormatterStyle width,
                  UDisplayContext      capitalizationContext,
                  UErrorCode*          status );

/**
 * Close a URelativeDateTimeFormatter object. Once closed it may no longer be used.
 * @param reldatefmt
 *            The URelativeDateTimeFormatter object to close.
 * @stable ICU 57
 */
U_CAPI void U_EXPORT2
ureldatefmt_close(URelativeDateTimeFormatter *reldatefmt);

struct UFormattedRelativeDateTime;
/**
 * Opaque struct to contain the results of a URelativeDateTimeFormatter operation.
 * @stable ICU 64
 */
typedef struct UFormattedRelativeDateTime UFormattedRelativeDateTime;

/**
 * Creates an object to hold the result of a URelativeDateTimeFormatter
 * operation. The object can be used repeatedly; it is cleared whenever
 * passed to a format function.
 *
 * @param ec Set if an error occurs.
 * @return A pointer needing ownership.
 * @stable ICU 64
 */
U_CAPI UFormattedRelativeDateTime* U_EXPORT2
ureldatefmt_openResult(UErrorCode* ec);

/**
 * Returns a representation of a UFormattedRelativeDateTime as a UFormattedValue,
 * which can be subsequently passed to any API requiring that type.
 *
 * The returned object is owned by the UFormattedRelativeDateTime and is valid
 * only as long as the UFormattedRelativeDateTime is present and unchanged in memory.
 *
 * You can think of this method as a cast between types.
 *
 * @param ufrdt The object containing the formatted string.
 * @param ec Set if an error occurs.
 * @return A UFormattedValue owned by the input object.
 * @stable ICU 64
 */
U_CAPI const UFormattedValue* U_EXPORT2
ureldatefmt_resultAsValue(const UFormattedRelativeDateTime* ufrdt, UErrorCode* ec);

/**
 * Releases the UFormattedRelativeDateTime created by ureldatefmt_openResult.
 *
 * @param ufrdt The object to release.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ureldatefmt_closeResult(UFormattedRelativeDateTime* ufrdt);


#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalURelativeDateTimeFormatterPointer
 * "Smart pointer" class, closes a URelativeDateTimeFormatter via ureldatefmt_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 57
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalURelativeDateTimeFormatterPointer, URelativeDateTimeFormatter, ureldatefmt_close);

/**
 * \class LocalUFormattedRelativeDateTimePointer
 * "Smart pointer" class, closes a UFormattedRelativeDateTime via ureldatefmt_closeResult().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 64
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUFormattedRelativeDateTimePointer, UFormattedRelativeDateTime, ureldatefmt_closeResult);

U_NAMESPACE_END

#endif

/**
 * Format a combination of URelativeDateTimeUnit and numeric
 * offset using a numeric style, e.g. "1 week ago", "in 1 week",
 * "5 weeks ago", "in 5 weeks".
 *
 * @param reldatefmt
 *          The URelativeDateTimeFormatter object specifying the
 *          format conventions.
 * @param offset
 *          The signed offset for the specified unit. This will
 *          be formatted according to this object's UNumberFormat
 *          object.
 * @param unit
 *          The unit to use when formatting the relative
 *          date, e.g. UDAT_REL_UNIT_WEEK, UDAT_REL_UNIT_FRIDAY.
 * @param result
 *          A pointer to a buffer to receive the formatted result.
 * @param resultCapacity
 *          The maximum size of result.
 * @param status
 *          A pointer to a UErrorCode to receive any errors. In
 *          case of error status, the contents of result are
 *          undefined.
 * @return
 *          The length of the formatted result; may be greater
 *          than resultCapacity, in which case an error is returned.
 * @stable ICU 57
 */
U_CAPI int32_t U_EXPORT2
ureldatefmt_formatNumeric( const URelativeDateTimeFormatter* reldatefmt,
                    double                offset,
                    URelativeDateTimeUnit unit,
                    UChar*                result,
                    int32_t               resultCapacity,
                    UErrorCode*           status);

/**
 * Format a combination of URelativeDateTimeUnit and numeric
 * offset using a numeric style, e.g. "1 week ago", "in 1 week",
 * "5 weeks ago", "in 5 weeks".
 *
 * @param reldatefmt
 *          The URelativeDateTimeFormatter object specifying the
 *          format conventions.
 * @param offset
 *          The signed offset for the specified unit. This will
 *          be formatted according to this object's UNumberFormat
 *          object.
 * @param unit
 *          The unit to use when formatting the relative
 *          date, e.g. UDAT_REL_UNIT_WEEK, UDAT_REL_UNIT_FRIDAY.
 * @param result
 *          A pointer to a UFormattedRelativeDateTime to populate.
 * @param status
 *          A pointer to a UErrorCode to receive any errors. In
 *          case of error status, the contents of result are
 *          undefined.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ureldatefmt_formatNumericToResult(
    const URelativeDateTimeFormatter* reldatefmt,
    double                            offset,
    URelativeDateTimeUnit             unit,
    UFormattedRelativeDateTime*       result,
    UErrorCode*                       status);

/**
 * Format a combination of URelativeDateTimeUnit and numeric offset
 * using a text style if possible, e.g. "last week", "this week",
 * "next week", "yesterday", "tomorrow". Falls back to numeric
 * style if no appropriate text term is available for the specified
 * offset in the object's locale.
 *
 * @param reldatefmt
 *          The URelativeDateTimeFormatter object specifying the
 *          format conventions.
 * @param offset
 *          The signed offset for the specified unit.
 * @param unit
 *          The unit to use when formatting the relative
 *          date, e.g. UDAT_REL_UNIT_WEEK, UDAT_REL_UNIT_FRIDAY.
 * @param result
 *          A pointer to a buffer to receive the formatted result.
 * @param resultCapacity
 *          The maximum size of result.
 * @param status
 *          A pointer to a UErrorCode to receive any errors. In
 *          case of error status, the contents of result are
 *          undefined.
 * @return
 *          The length of the formatted result; may be greater
 *          than resultCapacity, in which case an error is returned.
 * @stable ICU 57
 */
U_CAPI int32_t U_EXPORT2
ureldatefmt_format( const URelativeDateTimeFormatter* reldatefmt,
                    double                offset,
                    URelativeDateTimeUnit unit,
                    UChar*                result,
                    int32_t               resultCapacity,
                    UErrorCode*           status);

/**
 * Format a combination of URelativeDateTimeUnit and numeric offset
 * using a text style if possible, e.g. "last week", "this week",
 * "next week", "yesterday", "tomorrow". Falls back to numeric
 * style if no appropriate text term is available for the specified
 * offset in the object's locale.
 *
 * This method populates a UFormattedRelativeDateTime, which exposes more
 * information than the string populated by format().
 *
 * @param reldatefmt
 *          The URelativeDateTimeFormatter object specifying the
 *          format conventions.
 * @param offset
 *          The signed offset for the specified unit.
 * @param unit
 *          The unit to use when formatting the relative
 *          date, e.g. UDAT_REL_UNIT_WEEK, UDAT_REL_UNIT_FRIDAY.
 * @param result
 *          A pointer to a UFormattedRelativeDateTime to populate.
 * @param status
 *          A pointer to a UErrorCode to receive any errors. In
 *          case of error status, the contents of result are
 *          undefined.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ureldatefmt_formatToResult(
    const URelativeDateTimeFormatter* reldatefmt,
    double                            offset,
    URelativeDateTimeUnit             unit,
    UFormattedRelativeDateTime*       result,
    UErrorCode*                       status);

/**
 * Combines a relative date string and a time string in this object's
 * locale. This is done with the same date-time separator used for the
 * default calendar in this locale to produce a result such as
 * "yesterday at 3:45 PM".
 *
 * @param reldatefmt
 *          The URelativeDateTimeFormatter object specifying the format conventions.
 * @param relativeDateString
 *          The relative date string.
 * @param relativeDateStringLen
 *          The length of relativeDateString; may be -1 if relativeDateString
 *          is zero-terminated.
 * @param timeString
 *          The time string.
 * @param timeStringLen
 *          The length of timeString; may be -1 if timeString is zero-terminated.
 * @param result
 *          A pointer to a buffer to receive the formatted result.
 * @param resultCapacity
 *          The maximum size of result.
 * @param status
 *          A pointer to a UErrorCode to receive any errors. In case of error status,
 *          the contents of result are undefined.
 * @return
 *          The length of the formatted result; may be greater than resultCapacity,
 *          in which case an error is returned.
 * @stable ICU 57
 */
U_CAPI int32_t U_EXPORT2
ureldatefmt_combineDateAndTime( const URelativeDateTimeFormatter* reldatefmt,
                    const UChar *     relativeDateString,
                    int32_t           relativeDateStringLen,
                    const UChar *     timeString,
                    int32_t           timeStringLen,
                    UChar*            result,
                    int32_t           resultCapacity,
                    UErrorCode*       status );

#endif /* !UCONFIG_NO_FORMATTING */

#endif
