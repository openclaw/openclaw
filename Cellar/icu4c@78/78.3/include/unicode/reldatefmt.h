// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*****************************************************************************
* Copyright (C) 2014-2016, International Business Machines Corporation and
* others.
* All Rights Reserved.
*****************************************************************************
*
* File RELDATEFMT.H
*****************************************************************************
*/

#ifndef __RELDATEFMT_H
#define __RELDATEFMT_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/uobject.h"
#include "unicode/udisplaycontext.h"
#include "unicode/ureldatefmt.h"
#include "unicode/locid.h"
#include "unicode/formattedvalue.h"

/**
 * \file
 * \brief C++ API: Formats relative dates such as "1 day ago" or "tomorrow"
 */

#if !UCONFIG_NO_FORMATTING

/**
 * Represents the unit for formatting a relative date. e.g "in 5 days"
 * or "in 3 months"
 * @stable ICU 53
 */
typedef enum UDateRelativeUnit {

    /**
     * Seconds
     * @stable ICU 53
     */
    UDAT_RELATIVE_SECONDS,

    /**
     * Minutes
     * @stable ICU 53
     */
    UDAT_RELATIVE_MINUTES,

    /**
     * Hours
     * @stable ICU 53
     */
    UDAT_RELATIVE_HOURS,

    /**
     * Days
     * @stable ICU 53
     */
    UDAT_RELATIVE_DAYS,

    /**
     * Weeks
     * @stable ICU 53
     */
    UDAT_RELATIVE_WEEKS,

    /**
     * Months
     * @stable ICU 53
     */
    UDAT_RELATIVE_MONTHS,

    /**
     * Years
     * @stable ICU 53
     */
    UDAT_RELATIVE_YEARS,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UDateRelativeUnit value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UDAT_RELATIVE_UNIT_COUNT
#endif  // U_HIDE_DEPRECATED_API
} UDateRelativeUnit;

/**
 * Represents an absolute unit.
 * @stable ICU 53
 */
typedef enum UDateAbsoluteUnit {

    // Days of week have to remain together and in order from Sunday to
    // Saturday.
    /**
     * Sunday
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_SUNDAY,

    /**
     * Monday
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_MONDAY,

    /**
     * Tuesday
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_TUESDAY,

    /**
     * Wednesday
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_WEDNESDAY,

    /**
     * Thursday
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_THURSDAY,

    /**
     * Friday
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_FRIDAY,

    /**
     * Saturday
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_SATURDAY,

    /**
     * Day
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_DAY,

    /**
     * Week
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_WEEK,

    /**
     * Month
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_MONTH,

    /**
     * Year
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_YEAR,

    /**
     * Now
     * @stable ICU 53
     */
    UDAT_ABSOLUTE_NOW,

    /**
     * Quarter
     * @stable ICU 63
     */
    UDAT_ABSOLUTE_QUARTER,

    /**
     * Hour
     * @stable ICU 65
     */
    UDAT_ABSOLUTE_HOUR,

    /**
     * Minute
     * @stable ICU 65
     */
    UDAT_ABSOLUTE_MINUTE,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UDateAbsoluteUnit value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UDAT_ABSOLUTE_UNIT_COUNT = UDAT_ABSOLUTE_NOW + 4
#endif  // U_HIDE_DEPRECATED_API
} UDateAbsoluteUnit;

/**
 * Represents a direction for an absolute unit e.g "Next Tuesday"
 * or "Last Tuesday"
 * @stable ICU 53
 */
typedef enum UDateDirection {

    /**
     * Two before. Not fully supported in every locale.
     * @stable ICU 53
     */
    UDAT_DIRECTION_LAST_2,

    /**
     * Last
     * @stable ICU 53
     */
    UDAT_DIRECTION_LAST,

    /**
     * This
     * @stable ICU 53
     */
    UDAT_DIRECTION_THIS,

    /**
     * Next
     * @stable ICU 53
     */
    UDAT_DIRECTION_NEXT,

    /**
     * Two after. Not fully supported in every locale.
     * @stable ICU 53
     */
    UDAT_DIRECTION_NEXT_2,

    /**
     * Plain, which means the absence of a qualifier.
     * @stable ICU 53
     */
    UDAT_DIRECTION_PLAIN,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UDateDirection value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UDAT_DIRECTION_COUNT
#endif  // U_HIDE_DEPRECATED_API
} UDateDirection;

U_NAMESPACE_BEGIN

class BreakIterator;
class RelativeDateTimeCacheData;
class SharedNumberFormat;
class SharedPluralRules;
class SharedBreakIterator;
class NumberFormat;
class UnicodeString;
class FormattedRelativeDateTime;
class FormattedRelativeDateTimeData;

/**
 * An immutable class containing the result of a relative datetime formatting operation.
 *
 * Instances of this class are immutable and thread-safe.
 *
 * Not intended for public subclassing.
 *
 * @stable ICU 64
 */
class U_I18N_API FormattedRelativeDateTime : public UMemory, public FormattedValue {
  public:
    /**
     * Default constructor; makes an empty FormattedRelativeDateTime.
     * @stable ICU 64
     */
    FormattedRelativeDateTime() : fData(nullptr), fErrorCode(U_INVALID_STATE_ERROR) {}

    /**
     * Move constructor: Leaves the source FormattedRelativeDateTime in an undefined state.
     * @stable ICU 64
     */
    FormattedRelativeDateTime(FormattedRelativeDateTime&& src) noexcept;

    /**
     * Destruct an instance of FormattedRelativeDateTime.
     * @stable ICU 64
     */
    virtual ~FormattedRelativeDateTime() override;

    /** Copying not supported; use move constructor instead. */
    FormattedRelativeDateTime(const FormattedRelativeDateTime&) = delete;

    /** Copying not supported; use move assignment instead. */
    FormattedRelativeDateTime& operator=(const FormattedRelativeDateTime&) = delete;

    /**
     * Move assignment: Leaves the source FormattedRelativeDateTime in an undefined state.
     * @stable ICU 64
     */
    FormattedRelativeDateTime& operator=(FormattedRelativeDateTime&& src) noexcept;

    /** @copydoc FormattedValue::toString() */
    UnicodeString toString(UErrorCode& status) const override;

    /** @copydoc FormattedValue::toTempString() */
    UnicodeString toTempString(UErrorCode& status) const override;

    /** @copydoc FormattedValue::appendTo() */
    Appendable &appendTo(Appendable& appendable, UErrorCode& status) const override;

    /** @copydoc FormattedValue::nextPosition() */
    UBool nextPosition(ConstrainedFieldPosition& cfpos, UErrorCode& status) const override;

  private:
    FormattedRelativeDateTimeData *fData;
    UErrorCode fErrorCode;
    explicit FormattedRelativeDateTime(FormattedRelativeDateTimeData *results)
        : fData(results), fErrorCode(U_ZERO_ERROR) {}
    explicit FormattedRelativeDateTime(UErrorCode errorCode)
        : fData(nullptr), fErrorCode(errorCode) {}
    friend class RelativeDateTimeFormatter;
};

/**
 * Formats simple relative dates. There are two types of relative dates that
 * it handles:
 * <ul>
 *   <li>relative dates with a quantity e.g "in 5 days"</li>
 *   <li>relative dates without a quantity e.g "next Tuesday"</li>
 * </ul>
 * <p>
 * This API is very basic and is intended to be a building block for more
 * fancy APIs. The caller tells it exactly what to display in a locale
 * independent way. While this class automatically provides the correct plural
 * forms, the grammatical form is otherwise as neutral as possible. It is the
 * caller's responsibility to handle cut-off logic such as deciding between
 * displaying "in 7 days" or "in 1 week." This API supports relative dates
 * involving one single unit. This API does not support relative dates
 * involving compound units,
 * e.g "in 5 days and 4 hours" nor does it support parsing.
 * <p>
 * This class is mostly thread safe and immutable with the following caveats:
 * 1. The assignment operator violates Immutability. It must not be used
 *    concurrently with other operations.
 * 2. Caller must not hold onto adopted pointers.
 * <p>
 * This class is not intended for public subclassing.
 * <p>
 * Here are some examples of use:
 * <blockquote>
 * <pre>
 * UErrorCode status = U_ZERO_ERROR;
 * UnicodeString appendTo;
 * RelativeDateTimeFormatter fmt(status);
 * // Appends "in 1 day"
 * fmt.format(
 *     1, UDAT_DIRECTION_NEXT, UDAT_RELATIVE_DAYS, appendTo, status);
 * // Appends "in 3 days"
 * fmt.format(
 *     3, UDAT_DIRECTION_NEXT, UDAT_RELATIVE_DAYS, appendTo, status);
 * // Appends "3.2 years ago"
 * fmt.format(
 *     3.2, UDAT_DIRECTION_LAST, UDAT_RELATIVE_YEARS, appendTo, status);
 * // Appends "last Sunday"
 * fmt.format(UDAT_DIRECTION_LAST, UDAT_ABSOLUTE_SUNDAY, appendTo, status);
 * // Appends "this Sunday"
 * fmt.format(UDAT_DIRECTION_THIS, UDAT_ABSOLUTE_SUNDAY, appendTo, status);
 * // Appends "next Sunday"
 * fmt.format(UDAT_DIRECTION_NEXT, UDAT_ABSOLUTE_SUNDAY, appendTo, status);
 * // Appends "Sunday"
 * fmt.format(UDAT_DIRECTION_PLAIN, UDAT_ABSOLUTE_SUNDAY, appendTo, status);
 *
 * // Appends "yesterday"
 * fmt.format(UDAT_DIRECTION_LAST, UDAT_ABSOLUTE_DAY, appendTo, status);
 * // Appends "today"
 * fmt.format(UDAT_DIRECTION_THIS, UDAT_ABSOLUTE_DAY, appendTo, status);
 * // Appends "tomorrow"
 * fmt.format(UDAT_DIRECTION_NEXT, UDAT_ABSOLUTE_DAY, appendTo, status);
 * // Appends "now"
 * fmt.format(UDAT_DIRECTION_PLAIN, UDAT_ABSOLUTE_NOW, appendTo, status);
 *
 * </pre>
 * </blockquote>
 * <p>
 * The UDateRelativeDateTimeFormatterStyle parameter allows selection of
 * different length styles: LONG ("3 seconds ago"), SHORT ("3 sec. ago"),
 * NARROW ("3s ago"). In the future, we may add more forms, such as
 * relative day periods ("yesterday afternoon"), etc.
 *
 * The RelativeDateTimeFormatter class is not intended for public subclassing.
 *
 * @stable ICU 53
 */
class U_I18N_API_CLASS RelativeDateTimeFormatter : public UObject {
public:

    /**
     * Create RelativeDateTimeFormatter with default locale.
     * @stable ICU 53
     */
    U_I18N_API RelativeDateTimeFormatter(UErrorCode& status);

    /**
     * Create RelativeDateTimeFormatter with given locale.
     * @stable ICU 53
     */
    U_I18N_API RelativeDateTimeFormatter(const Locale& locale, UErrorCode& status);

    /**
     * Create RelativeDateTimeFormatter with given locale and NumberFormat.
     *
     * @param locale the locale
     * @param nfToAdopt Constructed object takes ownership of this pointer.
     *   It is an error for caller to delete this pointer or change its
     *   contents after calling this constructor.
     * @param status Any error is returned here.
     * @stable ICU 53
     */
    U_I18N_API RelativeDateTimeFormatter(
        const Locale& locale, NumberFormat *nfToAdopt, UErrorCode& status);

    /**
     * Create RelativeDateTimeFormatter with given locale, NumberFormat,
     * and capitalization context.
     *
     * @param locale the locale
     * @param nfToAdopt Constructed object takes ownership of this pointer.
     *   It is an error for caller to delete this pointer or change its
     *   contents after calling this constructor. Caller may pass nullptr for
     *   this argument if they want default number format behavior.
     * @param style the format style. The UDAT_RELATIVE bit field has no effect.
     * @param capitalizationContext A value from UDisplayContext that pertains to
     * capitalization.
     * @param status Any error is returned here.
     * @stable ICU 54
     */
    U_I18N_API RelativeDateTimeFormatter(
            const Locale& locale,
            NumberFormat *nfToAdopt,
            UDateRelativeDateTimeFormatterStyle style,
            UDisplayContext capitalizationContext,
            UErrorCode& status);

    /**
     * Copy constructor.
     * @stable ICU 53
     */
    U_I18N_API RelativeDateTimeFormatter(const RelativeDateTimeFormatter& other);

    /**
     * Assignment operator.
     * @stable ICU 53
     */
    U_I18N_API RelativeDateTimeFormatter& operator=(
            const RelativeDateTimeFormatter& other);

    /**
     * Destructor.
     * @stable ICU 53
     */
    U_I18N_API virtual ~RelativeDateTimeFormatter();

    /**
     * Formats a relative date with a quantity such as "in 5 days" or
     * "3 months ago"
     *
     * This method returns a String. To get more information about the
     * formatting result, use formatToValue().
     *
     * @param quantity The numerical amount e.g 5. This value is formatted
     * according to this object's NumberFormat object.
     * @param direction NEXT means a future relative date; LAST means a past
     * relative date. If direction is anything else, this method sets
     * status to U_ILLEGAL_ARGUMENT_ERROR.
     * @param unit the unit e.g day? month? year?
     * @param appendTo The string to which the formatted result will be
     *  appended
     * @param status ICU error code returned here.
     * @return appendTo
     * @stable ICU 53
     */
    U_I18N_API UnicodeString& format(
            double quantity,
            UDateDirection direction,
            UDateRelativeUnit unit,
            UnicodeString& appendTo,
            UErrorCode& status) const;

    /**
     * Formats a relative date with a quantity such as "in 5 days" or
     * "3 months ago"
     *
     * This method returns a FormattedRelativeDateTime, which exposes more
     * information than the String returned by format().
     *
     * @param quantity The numerical amount e.g 5. This value is formatted
     * according to this object's NumberFormat object.
     * @param direction NEXT means a future relative date; LAST means a past
     * relative date. If direction is anything else, this method sets
     * status to U_ILLEGAL_ARGUMENT_ERROR.
     * @param unit the unit e.g day? month? year?
     * @param status ICU error code returned here.
     * @return The formatted relative datetime
     * @stable ICU 64
     */
    U_I18N_API FormattedRelativeDateTime formatToValue(
            double quantity,
            UDateDirection direction,
            UDateRelativeUnit unit,
            UErrorCode& status) const;

    /**
     * Formats a relative date without a quantity.
     *
     * This method returns a String. To get more information about the
     * formatting result, use formatToValue().
     *
     * @param direction NEXT, LAST, THIS, etc.
     * @param unit e.g SATURDAY, DAY, MONTH
     * @param appendTo The string to which the formatted result will be
     *  appended. If the value of direction is documented as not being fully
     *  supported in all locales then this method leaves appendTo unchanged if
     *  no format string is available.
     * @param status ICU error code returned here.
     * @return appendTo
     * @stable ICU 53
     */
    U_I18N_API UnicodeString& format(
            UDateDirection direction,
            UDateAbsoluteUnit unit,
            UnicodeString& appendTo,
            UErrorCode& status) const;

    /**
     * Formats a relative date without a quantity.
     *
     * This method returns a FormattedRelativeDateTime, which exposes more
     * information than the String returned by format().
     *
     * If the string is not available in the requested locale, the return
     * value will be empty (calling toString will give an empty string).
     *
     * @param direction NEXT, LAST, THIS, etc.
     * @param unit e.g SATURDAY, DAY, MONTH
     * @param status ICU error code returned here.
     * @return The formatted relative datetime
     * @stable ICU 64
     */
    U_I18N_API FormattedRelativeDateTime formatToValue(
            UDateDirection direction,
            UDateAbsoluteUnit unit,
            UErrorCode& status) const;

    /**
     * Format a combination of URelativeDateTimeUnit and numeric offset
     * using a numeric style, e.g. "1 week ago", "in 1 week",
     * "5 weeks ago", "in 5 weeks".
     *
     * This method returns a String. To get more information about the
     * formatting result, use formatNumericToValue().
     *
     * @param offset    The signed offset for the specified unit. This
     *                  will be formatted according to this object's
     *                  NumberFormat object.
     * @param unit      The unit to use when formatting the relative
     *                  date, e.g. UDAT_REL_UNIT_WEEK,
     *                  UDAT_REL_UNIT_FRIDAY.
     * @param appendTo  The string to which the formatted result will be
     *                  appended.
     * @param status    ICU error code returned here.
     * @return          appendTo
     * @stable ICU 57
     */
    U_I18N_API UnicodeString& formatNumeric(
            double offset,
            URelativeDateTimeUnit unit,
            UnicodeString& appendTo,
            UErrorCode& status) const;

    /**
     * Format a combination of URelativeDateTimeUnit and numeric offset
     * using a numeric style, e.g. "1 week ago", "in 1 week",
     * "5 weeks ago", "in 5 weeks".
     *
     * This method returns a FormattedRelativeDateTime, which exposes more
     * information than the String returned by formatNumeric().
     *
     * @param offset    The signed offset for the specified unit. This
     *                  will be formatted according to this object's
     *                  NumberFormat object.
     * @param unit      The unit to use when formatting the relative
     *                  date, e.g. UDAT_REL_UNIT_WEEK,
     *                  UDAT_REL_UNIT_FRIDAY.
     * @param status    ICU error code returned here.
     * @return          The formatted relative datetime
     * @stable ICU 64
     */
    U_I18N_API FormattedRelativeDateTime formatNumericToValue(
            double offset,
            URelativeDateTimeUnit unit,
            UErrorCode& status) const;

    /**
     * Format a combination of URelativeDateTimeUnit and numeric offset
     * using a text style if possible, e.g. "last week", "this week",
     * "next week", "yesterday", "tomorrow". Falls back to numeric
     * style if no appropriate text term is available for the specified
     * offset in the object's locale.
     *
     * This method returns a String. To get more information about the
     * formatting result, use formatToValue().
     *
     * @param offset    The signed offset for the specified unit.
     * @param unit      The unit to use when formatting the relative
     *                  date, e.g. UDAT_REL_UNIT_WEEK,
     *                  UDAT_REL_UNIT_FRIDAY.
     * @param appendTo  The string to which the formatted result will be
     *                  appended.
     * @param status    ICU error code returned here.
     * @return          appendTo
     * @stable ICU 57
     */
    U_I18N_API UnicodeString& format(
            double offset,
            URelativeDateTimeUnit unit,
            UnicodeString& appendTo,
            UErrorCode& status) const;

    /**
     * Format a combination of URelativeDateTimeUnit and numeric offset
     * using a text style if possible, e.g. "last week", "this week",
     * "next week", "yesterday", "tomorrow". Falls back to numeric
     * style if no appropriate text term is available for the specified
     * offset in the object's locale.
     *
     * This method returns a FormattedRelativeDateTime, which exposes more
     * information than the String returned by format().
     *
     * @param offset    The signed offset for the specified unit.
     * @param unit      The unit to use when formatting the relative
     *                  date, e.g. UDAT_REL_UNIT_WEEK,
     *                  UDAT_REL_UNIT_FRIDAY.
     * @param status    ICU error code returned here.
     * @return          The formatted relative datetime
     * @stable ICU 64
     */
    U_I18N_API FormattedRelativeDateTime formatToValue(
            double offset,
            URelativeDateTimeUnit unit,
            UErrorCode& status) const;

    /**
     * Combines a relative date string and a time string in this object's
     * locale. This is done with the same date-time separator used for the
     * default calendar in this locale.
     *
     * @param relativeDateString the relative date, e.g 'yesterday'
     * @param timeString the time e.g '3:45'
     * @param appendTo concatenated date and time appended here
     * @param status ICU error code returned here.
     * @return appendTo
     * @stable ICU 53
     */
    U_I18N_API UnicodeString& combineDateAndTime(
            const UnicodeString& relativeDateString,
            const UnicodeString& timeString,
            UnicodeString& appendTo,
            UErrorCode& status) const;

    /**
     * Returns the NumberFormat this object is using.
     *
     * @stable ICU 53
     */
    U_I18N_API const NumberFormat& getNumberFormat() const;

    /**
     * Returns the capitalization context.
     *
     * @stable ICU 54
     */
    U_I18N_API UDisplayContext getCapitalizationContext() const;

    /**
     * Returns the format style.
     *
     * @stable ICU 54
     */
    U_I18N_API UDateRelativeDateTimeFormatterStyle getFormatStyle() const;

private:
    const RelativeDateTimeCacheData* fCache;
    const SharedNumberFormat *fNumberFormat;
    const SharedPluralRules *fPluralRules;
    UDateRelativeDateTimeFormatterStyle fStyle;
    UDisplayContext fContext;
#if !UCONFIG_NO_BREAK_ITERATION
    const SharedBreakIterator *fOptBreakIterator;
#else
    std::nullptr_t fOptBreakIterator = nullptr;
#endif // !UCONFIG_NO_BREAK_ITERATION
    Locale fLocale;
    void init(
            NumberFormat *nfToAdopt,
#if !UCONFIG_NO_BREAK_ITERATION
            BreakIterator *brkIter,
#else
            std::nullptr_t,
#endif // !UCONFIG_NO_BREAK_ITERATION
            UErrorCode &status);
    UnicodeString& adjustForContext(UnicodeString &) const;
    UBool checkNoAdjustForContext(UErrorCode& status) const;

    template<typename F, typename... Args>
    UnicodeString& doFormat(
            F callback,
            UnicodeString& appendTo,
            UErrorCode& status,
            Args... args) const;

    template<typename F, typename... Args>
    FormattedRelativeDateTime doFormatToValue(
            F callback,
            UErrorCode& status,
            Args... args) const;

    void formatImpl(
            double quantity,
            UDateDirection direction,
            UDateRelativeUnit unit,
            FormattedRelativeDateTimeData& output,
            UErrorCode& status) const;
    void formatAbsoluteImpl(
            UDateDirection direction,
            UDateAbsoluteUnit unit,
            FormattedRelativeDateTimeData& output,
            UErrorCode& status) const;
    void formatNumericImpl(
            double offset,
            URelativeDateTimeUnit unit,
            FormattedRelativeDateTimeData& output,
            UErrorCode& status) const;
    void formatRelativeImpl(
            double offset,
            URelativeDateTimeUnit unit,
            FormattedRelativeDateTimeData& output,
            UErrorCode& status) const;
};

U_NAMESPACE_END

#endif /* !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif /* __RELDATEFMT_H */
