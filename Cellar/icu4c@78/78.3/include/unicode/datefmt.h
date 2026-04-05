// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 ********************************************************************************
 *   Copyright (C) 1997-2016, International Business Machines
 *   Corporation and others.  All Rights Reserved.
 ********************************************************************************
 *
 * File DATEFMT.H
 *
 * Modification History:
 *
 *   Date        Name        Description
 *   02/19/97    aliu        Converted from java.
 *   04/01/97    aliu        Added support for centuries.
 *   07/23/98    stephen     JDK 1.2 sync
 *   11/15/99    weiv        Added support for week of year/day of week formatting
 ********************************************************************************
 */

#ifndef DATEFMT_H
#define DATEFMT_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/udat.h"
#include "unicode/calendar.h"
#include "unicode/numfmt.h"
#include "unicode/format.h"
#include "unicode/locid.h"
#include "unicode/enumset.h"
#include "unicode/udisplaycontext.h"

/**
 * \file
 * \brief C++ API: Abstract class for converting dates.
 */

U_NAMESPACE_BEGIN

class TimeZone;
class DateTimePatternGenerator;

/**
 * DateFormat is an abstract class for a family of classes that convert dates and
 * times from their internal representations to textual form and back again in a
 * language-independent manner. Converting from the internal representation (milliseconds
 * since midnight, January 1, 1970) to text is known as "formatting," and converting
 * from text to millis is known as "parsing."  We currently define only one concrete
 * subclass of DateFormat: SimpleDateFormat, which can handle pretty much all normal
 * date formatting and parsing actions.
 * <P>
 * DateFormat helps you to format and parse dates for any locale. Your code can
 * be completely independent of the locale conventions for months, days of the
 * week, or even the calendar format: lunar vs. solar.
 * <P>
 * To format a date for the current Locale, use one of the static factory
 * methods:
 * <pre>
 * \code
 *      DateFormat* dfmt = DateFormat::createDateInstance();
 *      UDate myDate = Calendar::getNow();
 *      UnicodeString myString;
 *      myString = dfmt->format( myDate, myString );
 * \endcode
 * </pre>
 * If you are formatting multiple numbers, it is more efficient to get the
 * format and use it multiple times so that the system doesn't have to fetch the
 * information about the local language and country conventions multiple times.
 * <pre>
 * \code
 *      DateFormat* df = DateFormat::createDateInstance();
 *      UnicodeString myString;
 *      UDate myDateArr[] = { 0.0, 100000000.0, 2000000000.0 }; // test values
 *      for (int32_t i = 0; i < 3; ++i) {
 *          myString.remove();
 *          cout << df->format( myDateArr[i], myString ) << endl;
 *      }
 * \endcode
 * </pre>
 * To get specific fields of a date, you can use UFieldPosition to
 * get specific fields.
 * <pre>
 * \code
 *      DateFormat* dfmt = DateFormat::createDateInstance();
 *      FieldPosition pos(DateFormat::YEAR_FIELD);
 *      UnicodeString myString;
 *      myString = dfmt->format( myDate, myString );
 *      cout << myString << endl;
 *      cout << pos.getBeginIndex() << "," << pos. getEndIndex() << endl;
 * \endcode
 * </pre>
 * To format a date for a different Locale, specify it in the call to
 * createDateInstance().
 * <pre>
 * \code
 *       DateFormat* df =
 *           DateFormat::createDateInstance( DateFormat::SHORT, Locale::getFrance());
 * \endcode
 * </pre>
 * You can use a DateFormat to parse also.
 * <pre>
 * \code
 *       UErrorCode status = U_ZERO_ERROR;
 *       UDate myDate = df->parse(myString, status);
 * \endcode
 * </pre>
 * Use createDateInstance() to produce the normal date format for that country.
 * There are other static factory methods available. Use createTimeInstance()
 * to produce the normal time format for that country. Use createDateTimeInstance()
 * to produce a DateFormat that formats both date and time. You can pass in
 * different options to these factory methods to control the length of the
 * result; from SHORT to MEDIUM to LONG to FULL. The exact result depends on the
 * locale, but generally:
 * <ul type=round>
 *   <li>   SHORT is completely numeric, such as 12/13/52 or 3:30pm
 *   <li>   MEDIUM is longer, such as Jan 12, 1952
 *   <li>   LONG is longer, such as January 12, 1952 or 3:30:32pm
 *   <li>   FULL is pretty completely specified, such as
 *          Tuesday, April 12, 1952 AD or 3:30:42pm PST.
 * </ul>
 * You can also set the time zone on the format if you wish. If you want even
 * more control over the format or parsing, (or want to give your users more
 * control), you can try casting the DateFormat you get from the factory methods
 * to a SimpleDateFormat. This will work for the majority of countries; just
 * remember to check getDynamicClassID() before carrying out the cast.
 * <P>
 * You can also use forms of the parse and format methods with ParsePosition and
 * FieldPosition to allow you to
 * <ul type=round>
 *   <li>   Progressively parse through pieces of a string.
 *   <li>   Align any particular field, or find out where it is for selection
 *          on the screen.
 * </ul>
 *
 * <p><em>User subclasses are not supported.</em> While clients may write
 * subclasses, such code will not necessarily work and will not be
 * guaranteed to work stably from release to release.
 */
class U_I18N_API_CLASS DateFormat : public Format {
public:

    /**
     * Constants for various style patterns. These reflect the order of items in
     * the DateTimePatterns resource. There are 4 time patterns, 4 date patterns,
     * the default date-time pattern, and 4 date-time patterns. Each block of 4 values
     * in the resource occurs in the order full, long, medium, short.
     * @stable ICU 2.4
     */
    enum EStyle
    {
        kNone   = -1,

        kFull   = 0,
        kLong   = 1,
        kMedium = 2,
        kShort  = 3,

        kDateOffset   = kShort + 1,
     // kFull   + kDateOffset = 4
     // kLong   + kDateOffset = 5
     // kMedium + kDateOffset = 6
     // kShort  + kDateOffset = 7

        kDateTime             = 8,
     // Default DateTime

        kDateTimeOffset = kDateTime + 1,
     // kFull   + kDateTimeOffset = 9
     // kLong   + kDateTimeOffset = 10
     // kMedium + kDateTimeOffset = 11
     // kShort  + kDateTimeOffset = 12

        // relative dates
        kRelative = (1 << 7),

        kFullRelative = (kFull | kRelative),

        kLongRelative = kLong | kRelative,

        kMediumRelative = kMedium | kRelative,

        kShortRelative = kShort | kRelative,


        kDefault      = kMedium,



    /**
     * These constants are provided for backwards compatibility only.
     * Please use the C++ style constants defined above.
     */
        FULL        = kFull,
        LONG        = kLong,
        MEDIUM        = kMedium,
        SHORT        = kShort,
        DEFAULT        = kDefault,
        DATE_OFFSET    = kDateOffset,
        NONE        = kNone,
        DATE_TIME    = kDateTime
    };

    /**
     * Destructor.
     * @stable ICU 2.0
     */
    U_I18N_API virtual ~DateFormat();

    /**
     * Clones this object polymorphically.
     * The caller owns the result and should delete it when done.
     * @return clone, or nullptr if an error occurred
     * @stable ICU 2.0
     */
    U_I18N_API virtual DateFormat* clone() const override = 0;

    /**
     * Equality operator.  Returns true if the two formats have the same behavior.
     * @stable ICU 2.0
     */
    U_I18N_API virtual bool operator==(const Format&) const override;


    using Format::format;

    /**
     * Format an object to produce a string. This method handles Formattable
     * objects with a UDate type. If a the Formattable object type is not a Date,
     * then it returns a failing UErrorCode.
     *
     * @param obj       The object to format. Must be a Date.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param pos       On input: an alignment field, if desired.
     *                  On output: the offsets of the alignment field.
     * @param status    Output param filled with success/failure status.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 2.0
     */
    U_I18N_API virtual UnicodeString& format(const Formattable& obj,
                                             UnicodeString& appendTo,
                                             FieldPosition& pos,
                                             UErrorCode& status) const override;

    /**
     * Format an object to produce a string. This method handles Formattable
     * objects with a UDate type. If a the Formattable object type is not a Date,
     * then it returns a failing UErrorCode.
     *
     * @param obj       The object to format. Must be a Date.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param posIter   On return, can be used to iterate over positions
     *                  of fields generated by this format call.  Field values
     *                  are defined in UDateFormatField.  Can be nullptr.
     * @param status    Output param filled with success/failure status.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 4.4
     */
    U_I18N_API virtual UnicodeString& format(const Formattable& obj,
                                             UnicodeString& appendTo,
                                             FieldPositionIterator* posIter,
                                             UErrorCode& status) const override;
    /**
     * Formats a date into a date/time string. This is an abstract method which
     * concrete subclasses must implement.
     * <P>
     * On input, the FieldPosition parameter may have its "field" member filled with
     * an enum value specifying a field.  On output, the FieldPosition will be filled
     * in with the text offsets for that field.
     * <P> For example, given a time text
     * "1996.07.10 AD at 15:08:56 PDT", if the given fieldPosition.field is
     * UDAT_YEAR_FIELD, the offsets fieldPosition.beginIndex and
     * statfieldPositionus.getEndIndex will be set to 0 and 4, respectively.
     * <P> Notice
     * that if the same time field appears more than once in a pattern, the status will
     * be set for the first occurrence of that time field. For instance,
     * formatting a UDate to the time string "1 PM PDT (Pacific Daylight Time)"
     * using the pattern "h a z (zzzz)" and the alignment field
     * DateFormat::TIMEZONE_FIELD, the offsets fieldPosition.beginIndex and
     * fieldPosition.getEndIndex will be set to 5 and 8, respectively, for the first
     * occurrence of the timezone pattern character 'z'.
     *
     * @param cal           Calendar set to the date and time to be formatted
     *                      into a date/time string.  When the calendar type is
     *                      different from the internal calendar held by this
     *                      DateFormat instance, the date and the time zone will
     *                      be inherited from the input calendar, but other calendar
     *                      field values will be calculated by the internal calendar.
     * @param appendTo      Output parameter to receive result.
     *                      Result is appended to existing contents.
     * @param fieldPosition On input: an alignment field, if desired (see examples above)
     *                      On output: the offsets of the alignment field (see examples above)
     * @return              Reference to 'appendTo' parameter.
     * @stable ICU 2.1
     */
    U_I18N_API virtual UnicodeString& format(Calendar& cal,
                                             UnicodeString& appendTo,
                                             FieldPosition& fieldPosition) const = 0;

    /**
     * Formats a date into a date/time string. Subclasses should implement this method.
     *
     * @param cal       Calendar set to the date and time to be formatted
     *                  into a date/time string.  When the calendar type is
     *                  different from the internal calendar held by this
     *                  DateFormat instance, the date and the time zone will
     *                  be inherited from the input calendar, but other calendar
     *                  field values will be calculated by the internal calendar.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param posIter   On return, can be used to iterate over positions
     *                  of fields generated by this format call.  Field values
     *                  are defined in UDateFormatField.  Can be nullptr.
     * @param status    error status.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 4.4
     */
    U_I18N_API virtual UnicodeString& format(Calendar& cal,
                                             UnicodeString& appendTo,
                                             FieldPositionIterator* posIter,
                                             UErrorCode& status) const;
    /**
     * Formats a UDate into a date/time string.
     * <P>
     * On input, the FieldPosition parameter may have its "field" member filled with
     * an enum value specifying a field.  On output, the FieldPosition will be filled
     * in with the text offsets for that field.
     * <P> For example, given a time text
     * "1996.07.10 AD at 15:08:56 PDT", if the given fieldPosition.field is
     * UDAT_YEAR_FIELD, the offsets fieldPosition.beginIndex and
     * statfieldPositionus.getEndIndex will be set to 0 and 4, respectively.
     * <P> Notice
     * that if the same time field appears more than once in a pattern, the status will
     * be set for the first occurrence of that time field. For instance,
     * formatting a UDate to the time string "1 PM PDT (Pacific Daylight Time)"
     * using the pattern "h a z (zzzz)" and the alignment field
     * DateFormat::TIMEZONE_FIELD, the offsets fieldPosition.beginIndex and
     * fieldPosition.getEndIndex will be set to 5 and 8, respectively, for the first
     * occurrence of the timezone pattern character 'z'.
     *
     * @param date          UDate to be formatted into a date/time string.
     * @param appendTo      Output parameter to receive result.
     *                      Result is appended to existing contents.
     * @param fieldPosition On input: an alignment field, if desired (see examples above)
     *                      On output: the offsets of the alignment field (see examples above)
     * @return              Reference to 'appendTo' parameter.
     * @stable ICU 2.0
     */
    U_I18N_API UnicodeString& format(UDate date,
                                     UnicodeString& appendTo,
                                     FieldPosition& fieldPosition) const;

    /**
     * Formats a UDate into a date/time string.
     *
     * @param date      UDate to be formatted into a date/time string.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param posIter   On return, can be used to iterate over positions
     *                  of fields generated by this format call.  Field values
     *                  are defined in UDateFormatField.  Can be nullptr.
     * @param status    error status.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 4.4
     */
    U_I18N_API UnicodeString& format(UDate date,
                                     UnicodeString& appendTo,
                                     FieldPositionIterator* posIter,
                                     UErrorCode& status) const;
    /**
     * Formats a UDate into a date/time string. If there is a problem, you won't
     * know, using this method. Use the overloaded format() method which takes a
     * FieldPosition& to detect formatting problems.
     *
     * @param date      The UDate value to be formatted into a string.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 2.0
     */
    U_I18N_API UnicodeString& format(UDate date, UnicodeString& appendTo) const;

    /**
     * Parse a date/time string. For example, a time text "07/10/96 4:5 PM, PDT"
     * will be parsed into a UDate that is equivalent to Date(837039928046).
     * Parsing begins at the beginning of the string and proceeds as far as
     * possible.  Assuming no parse errors were encountered, this function
     * doesn't return any information about how much of the string was consumed
     * by the parsing.  If you need that information, use the version of
     * parse() that takes a ParsePosition.
     * <P>
     * By default, parsing is lenient: If the input is not in the form used by
     * this object's format method but can still be parsed as a date, then the
     * parse succeeds. Clients may insist on strict adherence to the format by
     * calling setLenient(false).
     * @see DateFormat::setLenient(boolean)
     * <P>
     * Note that the normal date formats associated with some calendars - such
     * as the Chinese lunar calendar - do not specify enough fields to enable
     * dates to be parsed unambiguously. In the case of the Chinese lunar
     * calendar, while the year within the current 60-year cycle is specified,
     * the number of such cycles since the start date of the calendar (in the
     * ERA field of the Calendar object) is not normally part of the format,
     * and parsing may assume the wrong era. For cases such as this it is
     * recommended that clients parse using the method
     * parse(const UnicodeString&, Calendar& cal, ParsePosition&)
     * with the Calendar passed in set to the current date, or to a date
     * within the era/cycle that should be assumed if absent in the format.
     *
     * @param text      The date/time string to be parsed into a UDate value.
     * @param status    Output param to be set to success/failure code. If
     *                  'text' cannot be parsed, it will be set to a failure
     *                  code.
     * @return          The parsed UDate value, if successful.
     * @stable ICU 2.0
     */
    U_I18N_API virtual UDate parse(const UnicodeString& text, UErrorCode& status) const;

    /**
     * Parse a date/time string beginning at the given parse position. For
     * example, a time text "07/10/96 4:5 PM, PDT" will be parsed into a Date
     * that is equivalent to Date(837039928046).
     * <P>
     * By default, parsing is lenient: If the input is not in the form used by
     * this object's format method but can still be parsed as a date, then the
     * parse succeeds. Clients may insist on strict adherence to the format by
     * calling setLenient(false).
     * @see DateFormat::setLenient(boolean)
     *
     * @param text  The date/time string to be parsed.
     * @param cal   A Calendar set on input to the date and time to be used for
     *              missing values in the date/time string being parsed, and set
     *              on output to the parsed date/time. When the calendar type is
     *              different from the internal calendar held by this DateFormat
     *              instance, the internal calendar will be cloned to a work
     *              calendar set to the same milliseconds and time zone as the
     *              cal parameter, field values will be parsed based on the work
     *              calendar, then the result (milliseconds and time zone) will
     *              be set in this calendar.
     * @param pos   On input, the position at which to start parsing; on
     *              output, the position at which parsing terminated, or the
     *              start position if the parse failed.
     * @stable ICU 2.1
     */
    U_I18N_API virtual void parse(const UnicodeString& text,
                                  Calendar& cal,
                                  ParsePosition& pos) const = 0;

    /**
     * Parse a date/time string beginning at the given parse position. For
     * example, a time text "07/10/96 4:5 PM, PDT" will be parsed into a Date
     * that is equivalent to Date(837039928046).
     * <P>
     * By default, parsing is lenient: If the input is not in the form used by
     * this object's format method but can still be parsed as a date, then the
     * parse succeeds. Clients may insist on strict adherence to the format by
     * calling setLenient(false).
     * @see DateFormat::setLenient(boolean)
     * <P>
     * Note that the normal date formats associated with some calendars - such
     * as the Chinese lunar calendar - do not specify enough fields to enable
     * dates to be parsed unambiguously. In the case of the Chinese lunar
     * calendar, while the year within the current 60-year cycle is specified,
     * the number of such cycles since the start date of the calendar (in the
     * ERA field of the Calendar object) is not normally part of the format,
     * and parsing may assume the wrong era. For cases such as this it is
     * recommended that clients parse using the method
     * parse(const UnicodeString&, Calendar& cal, ParsePosition&)
     * with the Calendar passed in set to the current date, or to a date
     * within the era/cycle that should be assumed if absent in the format.
     *
     * @param text  The date/time string to be parsed into a UDate value.
     * @param pos   On input, the position at which to start parsing; on
     *              output, the position at which parsing terminated, or the
     *              start position if the parse failed.
     * @return      A valid UDate if the input could be parsed.
     * @stable ICU 2.0
     */
    U_I18N_API UDate parse(const UnicodeString& text, ParsePosition& pos) const;

    /**
     * Parse a string to produce an object. This methods handles parsing of
     * date/time strings into Formattable objects with UDate types.
     * <P>
     * Before calling, set parse_pos.index to the offset you want to start
     * parsing at in the source. After calling, parse_pos.index is the end of
     * the text you parsed. If error occurs, index is unchanged.
     * <P>
     * When parsing, leading whitespace is discarded (with a successful parse),
     * while trailing whitespace is left as is.
     * <P>
     * See Format::parseObject() for more.
     *
     * @param source    The string to be parsed into an object.
     * @param result    Formattable to be set to the parse result.
     *                  If parse fails, return contents are undefined.
     * @param parse_pos The position to start parsing at. Upon return
     *                  this param is set to the position after the
     *                  last character successfully parsed. If the
     *                  source is not parsed successfully, this param
     *                  will remain unchanged.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void parseObject(const UnicodeString& source,
                                        Formattable& result,
                                        ParsePosition& parse_pos) const override;

    /**
     * Create a default date/time formatter that uses the SHORT style for both
     * the date and the time.
     *
     * @return A date/time formatter which the caller owns.
     * @stable ICU 2.0
     */
    U_I18N_API static DateFormat* U_EXPORT2 createInstance();

    /**
     * Creates a time formatter with the given formatting style for the given
     * locale.
     *
     * @param style     The given formatting style. For example,
     *                  SHORT for "h:mm a" in the US locale. Relative
     *                  time styles are not currently supported.
     * @param aLocale   The given locale.
     * @return          A time formatter which the caller owns.
     * @stable ICU 2.0
     */
    U_I18N_API static DateFormat* U_EXPORT2
    createTimeInstance(EStyle style = kDefault, const Locale& aLocale = Locale::getDefault());

    /**
     * Creates a date formatter with the given formatting style for the given
     * const locale.
     *
     * @param style     The given formatting style. For example, SHORT for "M/d/yy" in the
     *                  US locale. As currently implemented, relative date formatting only
     *                  affects a limited range of calendar days before or after the
     *                  current date, based on the CLDR &lt;field type="day"&gt;/&lt;relative&gt; data:
     *                  For example, in English, "Yesterday", "Today", and "Tomorrow".
     *                  Outside of this range, dates are formatted using the corresponding
     *                  non-relative style.
     * @param aLocale   The given locale.
     * @return          A date formatter which the caller owns.
     * @stable ICU 2.0
     */
    U_I18N_API static DateFormat* U_EXPORT2
    createDateInstance(EStyle style = kDefault, const Locale& aLocale = Locale::getDefault());

    /**
     * Creates a date/time formatter with the given formatting styles for the
     * given locale.
     *
     * @param dateStyle The given formatting style for the date portion of the result.
     *                  For example, SHORT for "M/d/yy" in the US locale. As currently
     *                  implemented, relative date formatting only affects a limited range
     *                  of calendar days before or after the current date, based on the
     *                  CLDR &lt;field type="day"&gt;/&lt;relative&gt; data: For example, in English,
     *                  "Yesterday", "Today", and "Tomorrow". Outside of this range, dates
     *                  are formatted using the corresponding non-relative style.
     * @param timeStyle The given formatting style for the time portion of the result.
     *                  For example, SHORT for "h:mm a" in the US locale. Relative
     *                  time styles are not currently supported.
     * @param aLocale   The given locale.
     * @return          A date/time formatter which the caller owns.
     * @stable ICU 2.0
     */
    U_I18N_API static DateFormat* U_EXPORT2
    createDateTimeInstance(EStyle dateStyle = kDefault,
                           EStyle timeStyle = kDefault,
                           const Locale& aLocale = Locale::getDefault());

#ifndef U_HIDE_INTERNAL_API
    /**
     * Returns the best pattern given a skeleton and locale.
     * @param locale the locale
     * @param skeleton the skeleton
     * @param status ICU error returned here
     * @return the best pattern.
     * @internal For ICU use only.
     */
    U_I18N_API static UnicodeString getBestPattern(const Locale& locale,
                                                   const UnicodeString& skeleton,
                                                   UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Creates a date/time formatter for the given skeleton and 
     * default locale.
     *
     * @param skeleton The skeleton e.g "yMMMMd." Fields in the skeleton can
     *                 be in any order, and this method uses the locale to
     *                 map the skeleton to a pattern that includes locale
     *                 specific separators with the fields in the appropriate
     *                 order for that locale.
     * @param status   Any error returned here.
     * @return         A date/time formatter which the caller owns.
     * @stable ICU 55
     */
    U_I18N_API static DateFormat* U_EXPORT2 createInstanceForSkeleton(const UnicodeString& skeleton,
                                                                      UErrorCode& status);

    /**
     * Creates a date/time formatter for the given skeleton and locale.
     *
     * @param skeleton The skeleton e.g "yMMMMd." Fields in the skeleton can
     *                 be in any order, and this method uses the locale to
     *                 map the skeleton to a pattern that includes locale
     *                 specific separators with the fields in the appropriate
     *                 order for that locale.
     * @param locale  The given locale.
     * @param status   Any error returned here.
     * @return         A date/time formatter which the caller owns.
     * @stable ICU 55
     */
    U_I18N_API static DateFormat* U_EXPORT2 createInstanceForSkeleton(const UnicodeString& skeleton,
                                                                      const Locale& locale,
                                                                      UErrorCode& status);

    /**
     * Creates a date/time formatter for the given skeleton and locale.
     *
     * @param calendarToAdopt the calendar returned DateFormat is to use.
     * @param skeleton The skeleton e.g "yMMMMd." Fields in the skeleton can
     *                 be in any order, and this method uses the locale to
     *                 map the skeleton to a pattern that includes locale
     *                 specific separators with the fields in the appropriate
     *                 order for that locale.
     * @param locale  The given locale.
     * @param status   Any error returned here.
     * @return         A date/time formatter which the caller owns.
     * @stable ICU 55
     */
    U_I18N_API static DateFormat* U_EXPORT2 createInstanceForSkeleton(Calendar* calendarToAdopt,
                                                                      const UnicodeString& skeleton,
                                                                      const Locale& locale,
                                                                      UErrorCode& status);

    /**
     * Gets the set of locales for which DateFormats are installed.
     * @param count Filled in with the number of locales in the list that is returned.
     * @return the set of locales for which DateFormats are installed.  The caller
     *  does NOT own this list and must not delete it.
     * @stable ICU 2.0
     */
    U_I18N_API static const Locale* U_EXPORT2 getAvailableLocales(int32_t& count);

    /**
     * Returns whether both date/time parsing in the encapsulated Calendar object and DateFormat whitespace &
     * numeric processing is lenient.
     * @stable ICU 2.0
     */
    U_I18N_API virtual UBool isLenient() const;

    /**
     * Specifies whether date/time parsing is to be lenient.  With
     * lenient parsing, the parser may use heuristics to interpret inputs that
     * do not precisely match this object's format.  Without lenient parsing,
     * inputs must match this object's format more closely.
     * 
     * Note: ICU 53 introduced finer grained control of leniency (and added 
     * new control points) making the preferred method a combination of 
     * setCalendarLenient() & setBooleanAttribute() calls. 
     * This method supports prior functionality but may not support all 
     * future leniency control & behavior of DateFormat. For control of pre 53 leniency,  
     * Calendar and DateFormat whitespace & numeric tolerance, this method is safe to 
     * use. However, mixing leniency control via this method and modification of the 
     * newer attributes via setBooleanAttribute() may produce undesirable 
     * results.
     *
     * @param lenient  True specifies date/time interpretation to be lenient.
     * @see Calendar::setLenient
     * @stable ICU 2.0     
     */
    U_I18N_API virtual void setLenient(UBool lenient);


    /**
     * Returns whether date/time parsing in the encapsulated Calendar object processing is lenient.
     * @stable ICU 53
     */
    U_I18N_API virtual UBool isCalendarLenient() const;

    /**
     * Specifies whether encapsulated Calendar date/time parsing is to be lenient.  With
     * lenient parsing, the parser may use heuristics to interpret inputs that
     * do not precisely match this object's format.  Without lenient parsing,
     * inputs must match this object's format more closely.
     * @param lenient when true, parsing is lenient
     * @see com.ibm.icu.util.Calendar#setLenient
     * @stable ICU 53
     */
    U_I18N_API virtual void setCalendarLenient(UBool lenient);


    /**
     * Gets the calendar associated with this date/time formatter.
     * The calendar is owned by the formatter and must not be modified.
     * Also, the calendar does not reflect the results of a parse operation.
     * To parse to a calendar, use {@link #parse(const UnicodeString&, Calendar& cal, ParsePosition&) const parse(const UnicodeString&, Calendar& cal, ParsePosition&)}
     * @return the calendar associated with this date/time formatter.
     * @stable ICU 2.0
     */
    U_I18N_API virtual const Calendar* getCalendar() const;

    /**
     * Set the calendar to be used by this date format. Initially, the default
     * calendar for the specified or default locale is used.  The caller should
     * not delete the Calendar object after it is adopted by this call.
     * Adopting a new calendar will change to the default symbols.
     *
     * @param calendarToAdopt    Calendar object to be adopted.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void adoptCalendar(Calendar* calendarToAdopt);

    /**
     * Set the calendar to be used by this date format. Initially, the default
     * calendar for the specified or default locale is used.
     *
     * @param newCalendar Calendar object to be set.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void setCalendar(const Calendar& newCalendar);

    /**
     * Gets the number formatter which this date/time formatter uses to format
     * and parse the numeric portions of the pattern.
     * @return the number formatter which this date/time formatter uses.
     * @stable ICU 2.0
     */
    U_I18N_API virtual const NumberFormat* getNumberFormat() const;

    /**
     * Allows you to set the number formatter.  The caller should
     * not delete the NumberFormat object after it is adopted by this call.
     * @param formatToAdopt     NumberFormat object to be adopted.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void adoptNumberFormat(NumberFormat* formatToAdopt);

    /**
     * Allows you to set the number formatter.
     * @param newNumberFormat  NumberFormat object to be set.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void setNumberFormat(const NumberFormat& newNumberFormat);

    /**
     * Returns a reference to the TimeZone used by this DateFormat's calendar.
     * @return the time zone associated with the calendar of DateFormat.
     * @stable ICU 2.0
     */
    U_I18N_API virtual const TimeZone& getTimeZone() const;

    /**
     * Sets the time zone for the calendar of this DateFormat object. The caller
     * no longer owns the TimeZone object and should not delete it after this call.
     * @param zoneToAdopt the TimeZone to be adopted.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void adoptTimeZone(TimeZone* zoneToAdopt);

    /**
     * Sets the time zone for the calendar of this DateFormat object.
     * @param zone the new time zone.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void setTimeZone(const TimeZone& zone);

    /**
     * Set a particular UDisplayContext value in the formatter, such as
     * UDISPCTX_CAPITALIZATION_FOR_STANDALONE.
     * @param value The UDisplayContext value to set.
     * @param status Input/output status. If at entry this indicates a failure
     *               status, the function will do nothing; otherwise this will be
     *               updated with any new status from the function. 
     * @stable ICU 53
     */
    U_I18N_API virtual void setContext(UDisplayContext value, UErrorCode& status);

    /**
     * Get the formatter's UDisplayContext value for the specified UDisplayContextType,
     * such as UDISPCTX_TYPE_CAPITALIZATION.
     * @param type The UDisplayContextType whose value to return
     * @param status Input/output status. If at entry this indicates a failure
     *               status, the function will do nothing; otherwise this will be
     *               updated with any new status from the function. 
     * @return The UDisplayContextValue for the specified type.
     * @stable ICU 53
     */
    U_I18N_API virtual UDisplayContext getContext(UDisplayContextType type, UErrorCode& status) const;

    /**
     * Sets an boolean attribute on this DateFormat.
     * May return U_UNSUPPORTED_ERROR if this instance does not support
     * the specified attribute.
     * @param attr the attribute to set
     * @param newvalue new value
     * @param status the error type
     * @return *this - for chaining (example: format.setAttribute(...).setAttribute(...) )
     * @stable ICU 53
     */
    U_I18N_API virtual DateFormat& U_EXPORT2 setBooleanAttribute(UDateFormatBooleanAttribute attr,
                                                                 UBool newvalue, UErrorCode& status);

    /**
     * Returns a boolean from this DateFormat
     * May return U_UNSUPPORTED_ERROR if this instance does not support
     * the specified attribute.
     * @param attr the attribute to set
     * @param status the error type
     * @return the attribute value. Undefined if there is an error.
     * @stable ICU 53
     */
    U_I18N_API virtual UBool U_EXPORT2 getBooleanAttribute(UDateFormatBooleanAttribute attr,
                                                           UErrorCode& status) const;

protected:
    /**
     * Default constructor.  Creates a DateFormat with no Calendar or NumberFormat
     * associated with it.  This constructor depends on the subclasses to fill in
     * the calendar and numberFormat fields.
     * @stable ICU 2.0
     */
    U_I18N_API DateFormat();

    /**
     * Copy constructor.
     * @stable ICU 2.0
     */
    U_I18N_API DateFormat(const DateFormat&);

    /**
     * Default assignment operator.
     * @stable ICU 2.0
     */
    U_I18N_API DateFormat& operator=(const DateFormat&);

    /**
     * The calendar that DateFormat uses to produce the time field values needed
     * to implement date/time formatting. Subclasses should generally initialize
     * this to the default calendar for the locale associated with this DateFormat.
     * @stable ICU 2.4
     */
    Calendar* fCalendar;

    /**
     * The number formatter that DateFormat uses to format numbers in dates and
     * times. Subclasses should generally initialize this to the default number
     * format for the locale associated with this DateFormat.
     * @stable ICU 2.4
     */
    NumberFormat* fNumberFormat;


private:

    /**
     * Gets the date/time formatter with the given formatting styles for the
     * given locale.
     * @param dateStyle the given date formatting style.
     * @param timeStyle the given time formatting style.
     * @param inLocale the given locale.
     * @return a date/time formatter, or 0 on failure.
     */
    static DateFormat* U_EXPORT2 create(EStyle timeStyle, EStyle dateStyle, const Locale& inLocale);

     
    /**
     * enum set of active boolean attributes for this instance
     */
    EnumSet<UDateFormatBooleanAttribute, 0, UDAT_BOOLEAN_ATTRIBUTE_COUNT> fBoolFlags;


    UDisplayContext fCapitalizationContext;
    friend class DateFmtKeyByStyle;

public:
#ifndef U_HIDE_OBSOLETE_API
    /**
     * Field selector for FieldPosition for DateFormat fields.
     * @obsolete ICU 3.4 use UDateFormatField instead, since this API will be
     * removed in that release
     */
    enum EField
    {
        // Obsolete; use UDateFormatField instead
        kEraField = UDAT_ERA_FIELD,
        kYearField = UDAT_YEAR_FIELD,
        kMonthField = UDAT_MONTH_FIELD,
        kDateField = UDAT_DATE_FIELD,
        kHourOfDay1Field = UDAT_HOUR_OF_DAY1_FIELD,
        kHourOfDay0Field = UDAT_HOUR_OF_DAY0_FIELD,
        kMinuteField = UDAT_MINUTE_FIELD,
        kSecondField = UDAT_SECOND_FIELD,
        kMillisecondField = UDAT_FRACTIONAL_SECOND_FIELD,
        kDayOfWeekField = UDAT_DAY_OF_WEEK_FIELD,
        kDayOfYearField = UDAT_DAY_OF_YEAR_FIELD,
        kDayOfWeekInMonthField = UDAT_DAY_OF_WEEK_IN_MONTH_FIELD,
        kWeekOfYearField = UDAT_WEEK_OF_YEAR_FIELD,
        kWeekOfMonthField = UDAT_WEEK_OF_MONTH_FIELD,
        kAmPmField = UDAT_AM_PM_FIELD,
        kHour1Field = UDAT_HOUR1_FIELD,
        kHour0Field = UDAT_HOUR0_FIELD,
        kTimezoneField = UDAT_TIMEZONE_FIELD,
        kYearWOYField = UDAT_YEAR_WOY_FIELD,
        kDOWLocalField = UDAT_DOW_LOCAL_FIELD,
        kExtendedYearField = UDAT_EXTENDED_YEAR_FIELD,
        kJulianDayField = UDAT_JULIAN_DAY_FIELD,
        kMillisecondsInDayField = UDAT_MILLISECONDS_IN_DAY_FIELD,

        // Obsolete; use UDateFormatField instead
        ERA_FIELD = UDAT_ERA_FIELD,
        YEAR_FIELD = UDAT_YEAR_FIELD,
        MONTH_FIELD = UDAT_MONTH_FIELD,
        DATE_FIELD = UDAT_DATE_FIELD,
        HOUR_OF_DAY1_FIELD = UDAT_HOUR_OF_DAY1_FIELD,
        HOUR_OF_DAY0_FIELD = UDAT_HOUR_OF_DAY0_FIELD,
        MINUTE_FIELD = UDAT_MINUTE_FIELD,
        SECOND_FIELD = UDAT_SECOND_FIELD,
        MILLISECOND_FIELD = UDAT_FRACTIONAL_SECOND_FIELD,
        DAY_OF_WEEK_FIELD = UDAT_DAY_OF_WEEK_FIELD,
        DAY_OF_YEAR_FIELD = UDAT_DAY_OF_YEAR_FIELD,
        DAY_OF_WEEK_IN_MONTH_FIELD = UDAT_DAY_OF_WEEK_IN_MONTH_FIELD,
        WEEK_OF_YEAR_FIELD = UDAT_WEEK_OF_YEAR_FIELD,
        WEEK_OF_MONTH_FIELD = UDAT_WEEK_OF_MONTH_FIELD,
        AM_PM_FIELD = UDAT_AM_PM_FIELD,
        HOUR1_FIELD = UDAT_HOUR1_FIELD,
        HOUR0_FIELD = UDAT_HOUR0_FIELD,
        TIMEZONE_FIELD = UDAT_TIMEZONE_FIELD
    };
#endif  /* U_HIDE_OBSOLETE_API */
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _DATEFMT
//eof
