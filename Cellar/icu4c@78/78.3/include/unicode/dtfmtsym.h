// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
********************************************************************************
*   Copyright (C) 1997-2016, International Business Machines
*   Corporation and others.  All Rights Reserved.
********************************************************************************
*
* File DTFMTSYM.H
*
* Modification History:
*
*   Date        Name        Description
*   02/19/97    aliu        Converted from java.
*    07/21/98    stephen        Added getZoneIndex()
*                            Changed to match C++ conventions
********************************************************************************
*/

#ifndef DTFMTSYM_H
#define DTFMTSYM_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/calendar.h"
#include "unicode/strenum.h"
#include "unicode/uobject.h"
#include "unicode/locid.h"
#include "unicode/udat.h"
#include "unicode/ures.h"

/**
 * \file
 * \brief C++ API: Symbols for formatting dates.
 */

U_NAMESPACE_BEGIN

/* forward declaration */
class SimpleDateFormat;
class Hashtable;

/**
 * DateFormatSymbols is a public class for encapsulating localizable date-time
 * formatting data -- including timezone data. DateFormatSymbols is used by
 * DateFormat and SimpleDateFormat.
 * <P>
 * Rather than first creating a DateFormatSymbols to get a date-time formatter
 * by using a SimpleDateFormat constructor, clients are encouraged to create a
 * date-time formatter using the getTimeInstance(), getDateInstance(), or
 * getDateTimeInstance() method in DateFormat. Each of these methods can return a
 * date/time formatter initialized with a default format pattern along with the
 * date-time formatting data for a given or default locale. After a formatter is
 * created, clients may modify the format pattern using the setPattern function
 * as so desired. For more information on using these formatter factory
 * functions, see DateFormat.
 * <P>
 * If clients decide to create a date-time formatter with a particular format
 * pattern and locale, they can do so with new SimpleDateFormat(aPattern,
 * new DateFormatSymbols(aLocale)).  This will load the appropriate date-time
 * formatting data from the locale.
 * <P>
 * DateFormatSymbols objects are clonable. When clients obtain a
 * DateFormatSymbols object, they can feel free to modify the date-time
 * formatting data as necessary. For instance, clients can
 * replace the localized date-time format pattern characters with the ones that
 * they feel easy to remember. Or they can change the representative cities
 * originally picked by default to using their favorite ones.
 * <P>
 * DateFormatSymbols are not expected to be subclassed. Data for a calendar is
 * loaded out of resource bundles.  The 'type' parameter indicates the type of
 * calendar, for example, "gregorian" or "japanese".  If the type is not gregorian
 * (or nullptr, or an empty string) then the type is appended to the resource name,
 * for example,  'Eras_japanese' instead of 'Eras'.   If the resource 'Eras_japanese' did
 * not exist (even in root), then this class will fall back to just 'Eras', that is,
 * Gregorian data.  Therefore, the calendar implementor MUST ensure that the root
 * locale at least contains any resources that are to be particularized for the
 * calendar type.
 */
class U_I18N_API_CLASS DateFormatSymbols final : public UObject  {
public:
    /**
     * Construct a DateFormatSymbols object by loading format data from
     * resources for the default locale, in the default calendar (Gregorian).
     * <P>
     * NOTE: This constructor will never fail; if it cannot get resource
     * data for the default locale, it will return a last-resort object
     * based on hard-coded strings.
     *
     * @param status    Status code.  Failure
     *                  results if the resources for the default cannot be
     *                  found or cannot be loaded
     * @stable ICU 2.0
     */
    U_I18N_API DateFormatSymbols(UErrorCode& status);

    /**
     * Construct a DateFormatSymbols object by loading format data from
     * resources for the given locale, in the default calendar (Gregorian).
     *
     * @param locale    Locale to load format data from.
     * @param status    Status code.  Failure
     *                  results if the resources for the locale cannot be
     *                  found or cannot be loaded
     * @stable ICU 2.0
     */
    U_I18N_API DateFormatSymbols(const Locale& locale, UErrorCode& status);

#ifndef U_HIDE_INTERNAL_API
    /**
     * Construct a DateFormatSymbols object by loading format data from
     * resources for the default locale, in the default calendar (Gregorian).
     * <P>
     * NOTE: This constructor will never fail; if it cannot get resource
     * data for the default locale, it will return a last-resort object
     * based on hard-coded strings.
     *
     * @param type      Type of calendar (as returned by Calendar::getType).
     *                  Will be used to access the correct set of strings.
     *                  (nullptr or empty string defaults to "gregorian".)
     * @param status    Status code.  Failure
     *                  results if the resources for the default cannot be
     *                  found or cannot be loaded
     * @internal
     */
    U_I18N_API DateFormatSymbols(const char* type, UErrorCode& status);

    /**
     * Construct a DateFormatSymbols object by loading format data from
     * resources for the given locale, in the default calendar (Gregorian).
     *
     * @param locale    Locale to load format data from.
     * @param type      Type of calendar (as returned by Calendar::getType).
     *                  Will be used to access the correct set of strings.
     *                  (nullptr or empty string defaults to "gregorian".)
     * @param status    Status code.  Failure
     *                  results if the resources for the locale cannot be
     *                  found or cannot be loaded
     * @internal
     */
    U_I18N_API DateFormatSymbols(const Locale& locale, const char* type, UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Copy constructor.
     * @stable ICU 2.0
     */
    U_I18N_API DateFormatSymbols(const DateFormatSymbols&);

    /**
     * Assignment operator.
     * @stable ICU 2.0
     */
    U_I18N_API DateFormatSymbols& operator=(const DateFormatSymbols&);

    /**
     * Destructor. This is nonvirtual because this class is not designed to be
     * subclassed.
     * @stable ICU 2.0
     */
    U_I18N_API virtual ~DateFormatSymbols();

    /**
     * Return true if another object is semantically equal to this one.
     *
     * @param other    the DateFormatSymbols object to be compared with.
     * @return         true if other is semantically equal to this.
     * @stable ICU 2.0
     */
    U_I18N_API bool operator==(const DateFormatSymbols& other) const;

    /**
     * Return true if another object is semantically unequal to this one.
     *
     * @param other    the DateFormatSymbols object to be compared with.
     * @return         true if other is semantically unequal to this.
     * @stable ICU 2.0
     */
    U_I18N_API bool operator!=(const DateFormatSymbols& other) const { return !operator==(other); }

    /**
     * Gets abbreviated era strings. For example: "AD" and "BC".
     *
     * @param count    Filled in with length of the array.
     * @return         the era strings.
     * @stable ICU 2.0
     */
    U_I18N_API const UnicodeString* getEras(int32_t& count) const;

    /**
     * Sets abbreviated era strings. For example: "AD" and "BC".
     * @param eras  Array of era strings (DateFormatSymbols retains ownership.)
     * @param count Filled in with length of the array.
     * @stable ICU 2.0
     */
    U_I18N_API void setEras(const UnicodeString* eras, int32_t count);

    /**
     * Gets era name strings. For example: "Anno Domini" and "Before Christ".
     *
     * @param count    Filled in with length of the array.
     * @return         the era name strings.
     * @stable ICU 3.4
     */
    U_I18N_API const UnicodeString* getEraNames(int32_t& count) const;

    /**
     * Sets era name strings. For example: "Anno Domini" and "Before Christ".
     * @param eraNames  Array of era name strings (DateFormatSymbols retains ownership.)
     * @param count Filled in with length of the array.
     * @stable ICU 3.6
     */
    U_I18N_API void setEraNames(const UnicodeString* eraNames, int32_t count);

    /**
     * Gets narrow era strings. For example: "A" and "B".
     *
     * @param count    Filled in with length of the array.
     * @return         the narrow era strings.
     * @stable ICU 4.2
     */
    U_I18N_API const UnicodeString* getNarrowEras(int32_t& count) const;

    /**
     * Sets narrow era strings. For example: "A" and "B".
     * @param narrowEras  Array of narrow era strings (DateFormatSymbols retains ownership.)
     * @param count Filled in with length of the array.
     * @stable ICU 4.2
     */
    U_I18N_API void setNarrowEras(const UnicodeString* narrowEras, int32_t count);

    /**
     * Gets month strings. For example: "January", "February", etc.
     * @param count Filled in with length of the array.
     * @return the month strings. (DateFormatSymbols retains ownership.)
     * @stable ICU 2.0
     */
    U_I18N_API const UnicodeString* getMonths(int32_t& count) const;

    /**
     * Sets month strings. For example: "January", "February", etc.
     *
     * @param months    the new month strings. (not adopted; caller retains ownership)
     * @param count     Filled in with length of the array.
     * @stable ICU 2.0
     */
    U_I18N_API void setMonths(const UnicodeString* months, int32_t count);

    /**
     * Gets short month strings. For example: "Jan", "Feb", etc.
     *
     * @param count Filled in with length of the array.
     * @return the short month strings. (DateFormatSymbols retains ownership.)
     * @stable ICU 2.0
     */
    U_I18N_API const UnicodeString* getShortMonths(int32_t& count) const;

    /**
     * Sets short month strings. For example: "Jan", "Feb", etc.
     * @param count        Filled in with length of the array.
     * @param shortMonths  the new short month strings. (not adopted; caller retains ownership)
     * @stable ICU 2.0
     */
    U_I18N_API void setShortMonths(const UnicodeString* shortMonths, int32_t count);

    /**
     * Selector for date formatting context
     * @stable ICU 3.6
     */
    enum DtContextType {
        FORMAT,
        STANDALONE,
#ifndef U_HIDE_DEPRECATED_API
        /**
         * One more than the highest normal DtContextType value.
         * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
         */
        DT_CONTEXT_COUNT
#endif  // U_HIDE_DEPRECATED_API
    };

    /**
     * Selector for date formatting width
     * @stable ICU 3.6
     */
    enum DtWidthType {
        ABBREVIATED,
        WIDE,
        NARROW,
        /**
         * Short width is currently only supported for weekday names.
         * @stable ICU 51
         */
        SHORT,
#ifndef U_HIDE_DEPRECATED_API
        /**
         * One more than the highest normal DtWidthType value.
         * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
         */
        DT_WIDTH_COUNT = 4
#endif  // U_HIDE_DEPRECATED_API
    };

    /**
     * Gets month strings by width and context. For example: "January", "February", etc.
     * @param count Filled in with length of the array.
     * @param context The formatting context, either FORMAT or STANDALONE
     * @param width   The width of returned strings, either WIDE, ABBREVIATED, or NARROW.
     * @return the month strings. (DateFormatSymbols retains ownership.)
     * @stable ICU 3.4
     */
    U_I18N_API const UnicodeString* getMonths(int32_t& count,
                                              DtContextType context,
                                              DtWidthType width) const;

    /**
     * Sets month strings by width and context. For example: "January", "February", etc.
     *
     * @param months  The new month strings. (not adopted; caller retains ownership)
     * @param count   Filled in with length of the array.
     * @param context The formatting context, either FORMAT or STANDALONE
     * @param width   The width of returned strings, either WIDE, ABBREVIATED, or NARROW.
     * @stable ICU 3.6
     */
    U_I18N_API void setMonths(const UnicodeString* months,
                              int32_t count,
                              DtContextType context,
                              DtWidthType width);

    /**
     * Gets wide weekday strings. For example: "Sunday", "Monday", etc.
     * @param count        Filled in with length of the array.
     * @return the weekday strings. (DateFormatSymbols retains ownership.)
     * @stable ICU 2.0
     */
    U_I18N_API const UnicodeString* getWeekdays(int32_t& count) const;

    /**
     * Sets wide weekday strings. For example: "Sunday", "Monday", etc.
     * @param weekdays     the new weekday strings. (not adopted; caller retains ownership)
     * @param count        Filled in with length of the array.
     * @stable ICU 2.0
     */
    U_I18N_API void setWeekdays(const UnicodeString* weekdays, int32_t count);

    /**
     * Gets abbreviated weekday strings. For example: "Sun", "Mon", etc. (Note: The method name is
     * misleading; it does not get the CLDR-style "short" weekday strings, e.g. "Su", "Mo", etc.)
     * @param count        Filled in with length of the array.
     * @return             the abbreviated weekday strings. (DateFormatSymbols retains ownership.)
     * @stable ICU 2.0
     */
    U_I18N_API const UnicodeString* getShortWeekdays(int32_t& count) const;

    /**
     * Sets abbreviated weekday strings. For example: "Sun", "Mon", etc. (Note: The method name is
     * misleading; it does not set the CLDR-style "short" weekday strings, e.g. "Su", "Mo", etc.)
     * @param abbrevWeekdays  the new abbreviated weekday strings. (not adopted; caller retains ownership)
     * @param count           Filled in with length of the array.
     * @stable ICU 2.0
     */
    U_I18N_API void setShortWeekdays(const UnicodeString* abbrevWeekdays, int32_t count);

    /**
     * Gets weekday strings by width and context. For example: "Sunday", "Monday", etc.
     * @param count   Filled in with length of the array.
     * @param context The formatting context, either FORMAT or STANDALONE
     * @param width   The width of returned strings, either WIDE, ABBREVIATED, SHORT, or NARROW
     * @return the month strings. (DateFormatSymbols retains ownership.)
     * @stable ICU 3.4
     */
    U_I18N_API const UnicodeString* getWeekdays(int32_t& count,
                                                DtContextType context,
                                                DtWidthType width) const;

    /**
     * Sets weekday strings by width and context. For example: "Sunday", "Monday", etc.
     * @param weekdays  The new weekday strings. (not adopted; caller retains ownership)
     * @param count     Filled in with length of the array.
     * @param context   The formatting context, either FORMAT or STANDALONE
     * @param width     The width of returned strings, either WIDE, ABBREVIATED, SHORT, or NARROW
     * @stable ICU 3.6
     */
    U_I18N_API void setWeekdays(const UnicodeString* weekdays,
                                int32_t count,
                                DtContextType context,
                                DtWidthType width);

    /**
     * Gets quarter strings by width and context. For example: "1st Quarter", "2nd Quarter", etc.
     * @param count Filled in with length of the array.
     * @param context The formatting context, either FORMAT or STANDALONE
     * @param width   The width of returned strings, either WIDE, ABBREVIATED, or NARROW.
     * @return the quarter strings. (DateFormatSymbols retains ownership.)
     * @stable ICU 3.6
     */
    U_I18N_API const UnicodeString* getQuarters(int32_t& count,
                                                DtContextType context,
                                                DtWidthType width) const;

    /**
     * Sets quarter strings by width and context. For example: "1st Quarter", "2nd Quarter", etc.
     *
     * @param quarters  The new quarter strings. (not adopted; caller retains ownership)
     * @param count   The number of strings in the array.
     * @param context The formatting context, either FORMAT or STANDALONE
     * @param width   The width of set strings, either WIDE, ABBREVIATED, or NARROW.
     * @stable ICU 3.6
     */
    U_I18N_API void setQuarters(const UnicodeString* quarters,
                                int32_t count,
                                DtContextType context,
                                DtWidthType width);

    /**
     * Gets AM/PM strings. For example: "AM" and "PM".
     * @param count    Filled in with length of the array.
     * @return         The AM/PM strings. (DateFormatSymbols retains ownership.)
     * @stable ICU 2.0
     */
    U_I18N_API const UnicodeString* getAmPmStrings(int32_t& count) const;

    /**
     * Sets ampm strings. For example: "AM" and "PM".
     * @param ampms   The new ampm strings. (not adopted; caller retains ownership)
     * @param count   The number of strings in the array.
     * @stable ICU 2.0
     */
    U_I18N_API void setAmPmStrings(const UnicodeString* ampms, int32_t count);

#ifndef U_HIDE_DRAFT_API
    /**
     * Gets AM/PM strings with the specified width. For example: "A" and "P".
     * @param count    Filled in with length of the array.
     * @param context  The usage context. Currently ignored; FORMAT names always returned.
     * @param width    The width of returned strings, either WIDE, ABBREVIATED, or NARROW.
     * @return         The AM/PM strings. (DateFormatSymbols retains ownership.)
     * @draft ICU 78
     */
    U_I18N_API const UnicodeString* getAmPmStrings(int32_t& count,
                                                   DtContextType context,
                                                   DtWidthType width) const;

    /**
     * Sets AM/PM strings with the specified width. For example: "A" and "P".
     * @param ampms   The new AM/PM strings. (not adopted; caller retains ownership)
     * @param count   The number of strings in the array.
     * @param context The usage context. Currently ignored; always sets FORMAT names.
     * @param width   The width of set strings, either WIDE, ABBREVIATED, or NARROW.
     * @draft ICU 78
     */
    U_I18N_API void setAmPmStrings(const UnicodeString* ampms,
                                   int32_t count,
                                   DtContextType context,
                                   DtWidthType width);
#endif  /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_INTERNAL_API
    /**
     * This default time separator is used for formatting when the locale
     * doesn't specify any time separator, and always recognized when parsing.
     * @internal
     */
    U_I18N_API static const char16_t DEFAULT_TIME_SEPARATOR = 0x003a;  // ':'

    /**
     * This alternate time separator is always recognized when parsing.
     * @internal
     */
    U_I18N_API static const char16_t ALTERNATE_TIME_SEPARATOR = 0x002e;  // '.'

    /**
     * Gets the time separator string. For example: ":".
     * @param result Output param which will receive the time separator string.
     * @return       A reference to 'result'.
     * @internal
     */
    U_I18N_API UnicodeString& getTimeSeparatorString(UnicodeString& result) const;

    /**
     * Sets the time separator string. For example: ":".
     * @param newTimeSeparator the new time separator string.
     * @internal
     */
    U_I18N_API void setTimeSeparatorString(const UnicodeString& newTimeSeparator);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Gets cyclic year name strings if the calendar has them, by width and context.
     * For example: "jia-zi", "yi-chou", etc.
     * @param count     Filled in with length of the array.
     * @param context   The usage context: FORMAT, STANDALONE.
     * @param width     The requested name width: WIDE, ABBREVIATED, NARROW.
     * @return          The year name strings (DateFormatSymbols retains ownership),
     *                  or null if they are not available for this calendar.
     * @stable ICU 54
     */
    U_I18N_API const UnicodeString* getYearNames(int32_t& count,
                                                 DtContextType context,
                                                 DtWidthType width) const;

    /**
     * Sets cyclic year name strings by width and context. For example: "jia-zi", "yi-chou", etc.
     *
     * @param yearNames The new cyclic year name strings (not adopted; caller retains ownership).
     * @param count     The length of the array.
     * @param context   The usage context: FORMAT, STANDALONE (currently only FORMAT is supported).
     * @param width     The name width: WIDE, ABBREVIATED, NARROW (currently only ABBREVIATED is supported).
     * @stable ICU 54
     */
    U_I18N_API void setYearNames(const UnicodeString* yearNames,
                                 int32_t count,
                                 DtContextType context,
                                 DtWidthType width);

    /**
     * Gets calendar zodiac name strings if the calendar has them, by width and context.
     * For example: "Rat", "Ox", "Tiger", etc.
     * @param count     Filled in with length of the array.
     * @param context   The usage context: FORMAT, STANDALONE.
     * @param width     The requested name width: WIDE, ABBREVIATED, NARROW.
     * @return          The zodiac name strings (DateFormatSymbols retains ownership),
     *                  or null if they are not available for this calendar.
     * @stable ICU 54
     */
    U_I18N_API const UnicodeString* getZodiacNames(int32_t& count,
                                                   DtContextType context,
                                                   DtWidthType width) const;

    /**
     * Sets calendar zodiac name strings by width and context. For example: "Rat", "Ox", "Tiger", etc.
     *
     * @param zodiacNames The new zodiac name strings (not adopted; caller retains ownership).
     * @param count     The length of the array.
     * @param context   The usage context: FORMAT, STANDALONE (currently only FORMAT is supported).
     * @param width     The name width: WIDE, ABBREVIATED, NARROW (currently only ABBREVIATED is supported).
     * @stable ICU 54
     */
    U_I18N_API void setZodiacNames(const UnicodeString* zodiacNames,
                                   int32_t count,
                                   DtContextType context,
                                   DtWidthType width);

#ifndef U_HIDE_INTERNAL_API
    /**
     * Somewhat temporary constants for leap month pattern types, adequate for supporting
     * just leap month patterns as needed for Chinese lunar calendar.
     * Eventually we will add full support for different month pattern types (needed for
     * other calendars such as Hindu) at which point this approach will be replaced by a
     * more complete approach.
     * @internal
     */
    enum EMonthPatternType
    {
        kLeapMonthPatternFormatWide,
        kLeapMonthPatternFormatAbbrev,
        kLeapMonthPatternFormatNarrow,
        kLeapMonthPatternStandaloneWide,
        kLeapMonthPatternStandaloneAbbrev,
        kLeapMonthPatternStandaloneNarrow,
        kLeapMonthPatternNumeric,
        kMonthPatternsCount
    };

    /**
     * Somewhat temporary function for getting complete set of leap month patterns for all
     * contexts & widths, indexed by EMonthPatternType values. Returns nullptr if calendar
     * does not have leap month patterns. Note, there is currently no setter for this.
     * Eventually we will add full support for different month pattern types (needed for
     * other calendars such as Hindu) at which point this approach will be replaced by a
     * more complete approach.
     * @param count        Filled in with length of the array (may be 0).
     * @return             The leap month patterns (DateFormatSymbols retains ownership).
     *                     May be nullptr if there are no leap month patterns for this calendar.
     * @internal
     */
    U_I18N_API const UnicodeString* getLeapMonthPatterns(int32_t& count) const;

#endif  /* U_HIDE_INTERNAL_API */

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Gets timezone strings. These strings are stored in a 2-dimensional array.
     * @param rowCount      Output param to receive number of rows.
     * @param columnCount   Output param to receive number of columns.
     * @return              The timezone strings as a 2-d array. (DateFormatSymbols retains ownership.)
     * @deprecated ICU 3.6
     */
    U_I18N_API const UnicodeString** getZoneStrings(int32_t& rowCount, int32_t& columnCount) const;
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Sets timezone strings. These strings are stored in a 2-dimensional array.
     * <p><b>Note:</b> SimpleDateFormat no longer use the zone strings stored in
     * a DateFormatSymbols. Therefore, the time zone strings set by this method
     * have no effects in an instance of SimpleDateFormat for formatting time
     * zones.
     * @param strings       The timezone strings as a 2-d array to be copied. (not adopted; caller retains ownership)
     * @param rowCount      The number of rows (count of first index).
     * @param columnCount   The number of columns (count of second index).
     * @stable ICU 2.0
     */
    U_I18N_API void setZoneStrings(const UnicodeString* const* strings,
                                   int32_t rowCount,
                                   int32_t columnCount);

    /**
     * Get the non-localized date-time pattern characters.
     * @return    the non-localized date-time pattern characters
     * @stable ICU 2.0
     */
    U_I18N_API static const char16_t* getPatternUChars();

    /**
     * Gets localized date-time pattern characters. For example: 'u', 't', etc.
     * <p>
     * Note: ICU no longer provides localized date-time pattern characters for a locale
     * starting ICU 3.8.  This method returns the non-localized date-time pattern
     * characters unless user defined localized data is set by setLocalPatternChars.
     * @param result    Output param which will receive the localized date-time pattern characters.
     * @return          A reference to 'result'.
     * @stable ICU 2.0
     */
    U_I18N_API UnicodeString& getLocalPatternChars(UnicodeString& result) const;

    /**
     * Sets localized date-time pattern characters. For example: 'u', 't', etc.
     * @param newLocalPatternChars the new localized date-time
     * pattern characters.
     * @stable ICU 2.0
     */
    U_I18N_API void setLocalPatternChars(const UnicodeString& newLocalPatternChars);

    /**
     * Returns the locale for this object. Two flavors are available:
     * valid and actual locale.
     * @stable ICU 2.8
     */
    U_I18N_API Locale getLocale(ULocDataLocaleType type, UErrorCode& status) const;

    /* The following type and kCapContextUsageTypeCount cannot be #ifndef U_HIDE_INTERNAL_API,
       they are needed for .h file declarations. */ 
    /**
     * Constants for capitalization context usage types.
     * @internal
     */
    enum ECapitalizationContextUsageType
    {
#ifndef U_HIDE_INTERNAL_API
        kCapContextUsageOther = 0,
        kCapContextUsageMonthFormat,     /* except narrow */
        kCapContextUsageMonthStandalone, /* except narrow */
        kCapContextUsageMonthNarrow,
        kCapContextUsageDayFormat,     /* except narrow */
        kCapContextUsageDayStandalone, /* except narrow */
        kCapContextUsageDayNarrow,
        kCapContextUsageEraWide,
        kCapContextUsageEraAbbrev,
        kCapContextUsageEraNarrow,
        kCapContextUsageZoneLong,
        kCapContextUsageZoneShort,
        kCapContextUsageMetazoneLong,
        kCapContextUsageMetazoneShort,
#endif /* U_HIDE_INTERNAL_API */
        kCapContextUsageTypeCount = 14
    };

    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 2.2
     */
    U_I18N_API virtual UClassID getDynamicClassID() const override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 2.2
     */
    U_I18N_API static UClassID getStaticClassID();

private:

    friend class SimpleDateFormat;
    friend class DateFormatSymbolsSingleSetter; // see udat.cpp

    /**
     * Abbreviated era strings. For example: "AD" and "BC".
     */
    UnicodeString*  fEras;
    int32_t         fErasCount;

    /**
     * Era name strings. For example: "Anno Domini" and "Before Christ".
     */
    UnicodeString*  fEraNames;
    int32_t         fEraNamesCount;

    /**
     * Narrow era strings. For example: "A" and "B".
     */
    UnicodeString*  fNarrowEras;
    int32_t         fNarrowErasCount;

    /**
     * Month strings. For example: "January", "February", etc.
     */
    UnicodeString*  fMonths;
    int32_t         fMonthsCount;

    /**
     * Short month strings. For example: "Jan", "Feb", etc.
     */
    UnicodeString*  fShortMonths;
    int32_t         fShortMonthsCount;

    /**
     * Narrow month strings. For example: "J", "F", etc.
     */
    UnicodeString*  fNarrowMonths;
    int32_t         fNarrowMonthsCount;

    /**
     * Standalone Month strings. For example: "January", "February", etc.
     */
    UnicodeString*  fStandaloneMonths;
    int32_t         fStandaloneMonthsCount;

    /**
     * Standalone Short month strings. For example: "Jan", "Feb", etc.
     */
    UnicodeString*  fStandaloneShortMonths;
    int32_t         fStandaloneShortMonthsCount;

    /**
     * Standalone Narrow month strings. For example: "J", "F", etc.
     */
    UnicodeString*  fStandaloneNarrowMonths;
    int32_t         fStandaloneNarrowMonthsCount;

    /**
     * CLDR-style format wide weekday strings. For example: "Sunday", "Monday", etc.
     */
    UnicodeString*  fWeekdays;
    int32_t         fWeekdaysCount;

    /**
     * CLDR-style format abbreviated (not short) weekday strings. For example: "Sun", "Mon", etc.
     */
    UnicodeString*  fShortWeekdays;
    int32_t         fShortWeekdaysCount;

    /**
     * CLDR-style format short weekday strings. For example: "Su", "Mo", etc.
     */
    UnicodeString*  fShorterWeekdays;
    int32_t         fShorterWeekdaysCount;

    /**
     * CLDR-style format narrow weekday strings. For example: "S", "M", etc.
     */
    UnicodeString*  fNarrowWeekdays;
    int32_t         fNarrowWeekdaysCount;

    /**
     * CLDR-style standalone wide weekday strings. For example: "Sunday", "Monday", etc.
     */
    UnicodeString*  fStandaloneWeekdays;
    int32_t         fStandaloneWeekdaysCount;

    /**
     * CLDR-style standalone abbreviated (not short) weekday strings. For example: "Sun", "Mon", etc.
     */
    UnicodeString*  fStandaloneShortWeekdays;
    int32_t         fStandaloneShortWeekdaysCount;

    /**
     * CLDR-style standalone short weekday strings. For example: "Su", "Mo", etc.
     */
    UnicodeString*  fStandaloneShorterWeekdays;
    int32_t         fStandaloneShorterWeekdaysCount;

    /**
     * Standalone Narrow weekday strings. For example: "Sun", "Mon", etc.
     */
    UnicodeString*  fStandaloneNarrowWeekdays;
    int32_t         fStandaloneNarrowWeekdaysCount;

    /**
     * Ampm strings. For example: "AM" and "PM".
     */
    UnicodeString*  fAmPms;
    int32_t         fAmPmsCount;

    /**
     * Wide Ampm strings. For example: "ante meridiem" and "post meridiem".
     * These strings are uncommon but exist in a handful of locales.
     */
    UnicodeString*  fWideAmPms;
    int32_t         fWideAmPmsCount;

    /**
     * Narrow Ampm strings. For example: "a" and "p".
     */
    UnicodeString*  fNarrowAmPms;
    int32_t         fNarrowAmPmsCount;

    /**
     * Time separator string. For example: ":".
     */
    UnicodeString   fTimeSeparator;

    /**
     * Quarter strings. For example: "1st quarter", "2nd quarter", etc.
     */
    UnicodeString  *fQuarters;
    int32_t         fQuartersCount;

    /**
     * Short quarters. For example: "Q1", "Q2", etc.
     */
    UnicodeString  *fShortQuarters;
    int32_t         fShortQuartersCount;

    /**
     * Narrow quarters. For example: "1", "2", etc.
     * (In many, but not all, locales, this is the same as "Q", but there are locales for which this isn't true.)
     */
    UnicodeString  *fNarrowQuarters;
    int32_t         fNarrowQuartersCount;
    
    /**
     * Standalone quarter strings. For example: "1st quarter", "2nd quarter", etc.
     */
    UnicodeString  *fStandaloneQuarters;
    int32_t         fStandaloneQuartersCount;

    /**
     * Standalone short quarter strings. For example: "Q1", "Q2", etc.
     */
    UnicodeString  *fStandaloneShortQuarters;
    int32_t         fStandaloneShortQuartersCount;

    /**
     * Standalone narrow quarter strings. For example: "1", "2", etc.
     * (In many, but not all, locales, this is the same as "q", but there are locales for which this isn't true.)
     */
    UnicodeString  *fStandaloneNarrowQuarters;
    int32_t         fStandaloneNarrowQuartersCount;
    
    /**
     * All leap month patterns, for example "{0}bis".
     */
    UnicodeString  *fLeapMonthPatterns;
    int32_t         fLeapMonthPatternsCount;

    /**
     * Cyclic year names, for example: "jia-zi", "yi-chou", ... "gui-hai";
     * currently we only have data for format/abbreviated.
     * For the others, just get from format/abbreviated, ignore set.
     */
    UnicodeString  *fShortYearNames;
    int32_t         fShortYearNamesCount;

    /**
     * Cyclic zodiac names, for example "Rat", "Ox", "Tiger", etc.;
     * currently we only have data for format/abbreviated.
     * For the others, just get from format/abbreviated, ignore set.
     */
    UnicodeString  *fShortZodiacNames;
    int32_t         fShortZodiacNamesCount;

    /**
     * Localized names of time zones in this locale.  This is a
     * two-dimensional array of strings of size n by m,
     * where m is at least 5 and up to 7.  Each of the n rows is an
     * entry containing the localized names for a single TimeZone.
     *
     * Each such row contains (with i ranging from 0..n-1):
     * 
     * zoneStrings[i][0] - time zone ID
     *  example: America/Los_Angeles
     * zoneStrings[i][1] - long name of zone in standard time
     *  example: Pacific Standard Time
     * zoneStrings[i][2] - short name of zone in standard time
     *  example: PST
     * zoneStrings[i][3] - long name of zone in daylight savings time
     *  example: Pacific Daylight Time
     * zoneStrings[i][4] - short name of zone in daylight savings time
     *  example: PDT
     * zoneStrings[i][5] - location name of zone
     *  example: United States (Los Angeles)
     * zoneStrings[i][6] - long generic name of zone
     *  example: Pacific Time
     * zoneStrings[i][7] - short generic of zone
     *  example: PT
     *
     * The zone ID is not localized; it corresponds to the ID
     * value associated with a system time zone object.  All other entries
     * are localized names.  If a zone does not implement daylight savings
     * time, the daylight savings time names are ignored.
     *
     * Note:CLDR 1.5 introduced metazone and its historical mappings.
     * This simple two-dimensional array is no longer sufficient to represent
     * localized names and its historic changes.  Since ICU 3.8.1, localized
     * zone names extracted from ICU locale data is stored in a ZoneStringFormat
     * instance.  But we still need to support the old way of customizing
     * localized zone names, so we keep this field for the purpose.
     */
    UnicodeString   **fZoneStrings;         // Zone string array set by setZoneStrings
    UnicodeString   **fLocaleZoneStrings;   // Zone string array created by the locale
    int32_t         fZoneStringsRowCount;
    int32_t         fZoneStringsColCount;

    Locale                  fZSFLocale;         // Locale used for getting ZoneStringFormat

    /**
     * Localized date-time pattern characters. For example: use 'u' as 'y'.
     */
    UnicodeString   fLocalPatternChars;

    /**
     * Capitalization transforms. For each usage type, the first array element indicates
     * whether to titlecase for uiListOrMenu context, the second indicates whether to
     * titlecase for stand-alone context.
     */
     UBool fCapitalization[kCapContextUsageTypeCount][2];

    /**
     * Abbreviated (== short) day period strings.
     */
    UnicodeString  *fAbbreviatedDayPeriods;
    int32_t         fAbbreviatedDayPeriodsCount;

    /**
     * Wide day period strings.
     */
    UnicodeString  *fWideDayPeriods;
    int32_t         fWideDayPeriodsCount;

    /**
     * Narrow day period strings.
     */
    UnicodeString  *fNarrowDayPeriods;
    int32_t         fNarrowDayPeriodsCount;

    /**
     * Stand-alone abbreviated (== short) day period strings.
     */
    UnicodeString  *fStandaloneAbbreviatedDayPeriods;
    int32_t         fStandaloneAbbreviatedDayPeriodsCount;

    /**
     * Stand-alone wide day period strings.
     */
    UnicodeString  *fStandaloneWideDayPeriods;
    int32_t         fStandaloneWideDayPeriodsCount;

    /**
     * Stand-alone narrow day period strings.
     */
    UnicodeString  *fStandaloneNarrowDayPeriods;
    int32_t         fStandaloneNarrowDayPeriodsCount;

private:
    /** valid/actual locale information 
     *  these are always ICU locales, so the length should not be a problem
     */
    Locale validLocale;
    Locale actualLocale;

    DateFormatSymbols() = delete; // default constructor not implemented

    /**
     * Called by the constructors to actually load data from the resources
     *
     * @param locale               The locale to get symbols for.
     * @param type                 Calendar Type (as from Calendar::getType())
     * @param status               Input/output parameter, set to success or
     *                             failure code upon return.
     * @param useLastResortData    determine if use last resort data
     */
    void initializeData(const Locale& locale, const char *type,
                        UErrorCode& status, UBool useLastResortData = false);

    /**
     * Copy or alias an array in another object, as appropriate.
     *
     * @param dstArray    the copy destination array.
     * @param dstCount    fill in with the length of 'dstArray'.
     * @param srcArray    the source array to be copied.
     * @param srcCount    the length of items to be copied from the 'srcArray'.
     */
    static void assignArray(UnicodeString*& dstArray,
                            int32_t& dstCount,
                            const UnicodeString* srcArray,
                            int32_t srcCount);

    /**
     * Return true if the given arrays' contents are equal, or if the arrays are
     * identical (pointers are equal).
     *
     * @param array1   one array to be compared with.
     * @param array2   another array to be compared with.
     * @param count    the length of items to be copied.
     * @return         true if the given arrays' contents are equal, or if the arrays are
     *                 identical (pointers are equal).
     */
    static UBool arrayCompare(const UnicodeString* array1,
                             const UnicodeString* array2,
                             int32_t count);

    /**
     * Create a copy, in fZoneStrings, of the given zone strings array. The
     * member variables fZoneStringsRowCount and fZoneStringsColCount should be
     * set already by the caller.
     */
    void createZoneStrings(const UnicodeString *const * otherStrings);

    /**
     * Delete all the storage owned by this object.
     */
    void dispose();

    /**
     * Copy all of the other's data to this.
     * @param other the object to be copied.
     */
    void copyData(const DateFormatSymbols& other);

    /**
     * Create zone strings array by locale if not yet available
     */
    void initZoneStringsArray();

    /**
     * Delete just the zone strings.
     */
    void disposeZoneStrings();

    /**
     * Returns the date format field index of the pattern character c,
     * or UDAT_FIELD_COUNT if c is not a pattern character.
     */
    static UDateFormatField U_EXPORT2 getPatternCharIndex(char16_t c);

    /**
     * Returns true if f (with its pattern character repeated count times) is a numeric field.
     */
    static UBool U_EXPORT2 isNumericField(UDateFormatField f, int32_t count);

    /**
     * Returns true if c (repeated count times) is the pattern character for a numeric field.
     */
    static UBool U_EXPORT2 isNumericPatternChar(char16_t c, int32_t count);
public:
#ifndef U_HIDE_INTERNAL_API
    /**
     * Gets a DateFormatSymbols by locale.
     * Unlike the constructors which always use gregorian calendar, this
     * method uses the calendar in the locale. If the locale contains no
     * explicit calendar, this method uses the default calendar for that
     * locale.
     * @param locale the locale.
     * @param status error returned here.
     * @return the new DateFormatSymbols which the caller owns.
     * @internal For ICU use only.
     */
  U_I18N_API static DateFormatSymbols* createForLocale(const Locale& locale, UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _DTFMTSYM
//eof
