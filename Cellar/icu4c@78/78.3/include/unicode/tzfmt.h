// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2011-2015, International Business Machines Corporation and
* others. All Rights Reserved.
*******************************************************************************
*/
#ifndef __TZFMT_H
#define __TZFMT_H

/**
 * \file
 * \brief C++ API: TimeZoneFormat
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/format.h"
#include "unicode/timezone.h"
#include "unicode/tznames.h"

U_CDECL_BEGIN
/**
 * Constants for time zone display format style used by format/parse APIs
 * in TimeZoneFormat.
 * @stable ICU 50
 */
typedef enum UTimeZoneFormatStyle {
    /**
     * Generic location format, such as "United States Time (New York)", "Italy Time"
     * @stable ICU 50
     */
    UTZFMT_STYLE_GENERIC_LOCATION,
    /**
     * Generic long non-location format, such as "Eastern Time".
     * @stable ICU 50
     */
    UTZFMT_STYLE_GENERIC_LONG,
    /**
     * Generic short non-location format, such as "ET".
     * @stable ICU 50
     */
    UTZFMT_STYLE_GENERIC_SHORT,
    /**
     * Specific long format, such as "Eastern Standard Time".
     * @stable ICU 50
     */
    UTZFMT_STYLE_SPECIFIC_LONG,
    /**
     * Specific short format, such as "EST", "PDT".
     * @stable ICU 50
     */
    UTZFMT_STYLE_SPECIFIC_SHORT,
    /**
     * Localized GMT offset format, such as "GMT-05:00", "UTC+0100"
     * @stable ICU 50
     */
    UTZFMT_STYLE_LOCALIZED_GMT,
    /**
     * Short localized GMT offset format, such as "GMT-5", "UTC+1:30"
     * This style is equivalent to the LDML date format pattern "O".
     * @stable ICU 51
     */
    UTZFMT_STYLE_LOCALIZED_GMT_SHORT,
    /**
     * Short ISO 8601 local time difference (basic format) or the UTC indicator.
     * For example, "-05", "+0530", and "Z"(UTC).
     * This style is equivalent to the LDML date format pattern "X".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ISO_BASIC_SHORT,
    /**
     * Short ISO 8601 locale time difference (basic format).
     * For example, "-05" and "+0530".
     * This style is equivalent to the LDML date format pattern "x".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ISO_BASIC_LOCAL_SHORT,
    /**
     * Fixed width ISO 8601 local time difference (basic format) or the UTC indicator.
     * For example, "-0500", "+0530", and "Z"(UTC).
     * This style is equivalent to the LDML date format pattern "XX".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ISO_BASIC_FIXED,
    /**
     * Fixed width ISO 8601 local time difference (basic format).
     * For example, "-0500" and "+0530".
     * This style is equivalent to the LDML date format pattern "xx".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ISO_BASIC_LOCAL_FIXED,
    /**
     * ISO 8601 local time difference (basic format) with optional seconds field, or the UTC indicator.
     * For example, "-0500", "+052538", and "Z"(UTC).
     * This style is equivalent to the LDML date format pattern "XXXX".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ISO_BASIC_FULL,
    /**
     * ISO 8601 local time difference (basic format) with optional seconds field.
     * For example, "-0500" and "+052538".
     * This style is equivalent to the LDML date format pattern "xxxx".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ISO_BASIC_LOCAL_FULL,
    /**
     * Fixed width ISO 8601 local time difference (extended format) or the UTC indicator.
     * For example, "-05:00", "+05:30", and "Z"(UTC).
     * This style is equivalent to the LDML date format pattern "XXX".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ISO_EXTENDED_FIXED,
    /**
     * Fixed width ISO 8601 local time difference (extended format).
     * For example, "-05:00" and "+05:30".
     * This style is equivalent to the LDML date format pattern "xxx" and "ZZZZZ".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ISO_EXTENDED_LOCAL_FIXED,
    /**
     * ISO 8601 local time difference (extended format) with optional seconds field, or the UTC indicator.
     * For example, "-05:00", "+05:25:38", and "Z"(UTC).
     * This style is equivalent to the LDML date format pattern "XXXXX".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ISO_EXTENDED_FULL,
    /**
     * ISO 8601 local time difference (extended format) with optional seconds field.
     * For example, "-05:00" and "+05:25:38".
     * This style is equivalent to the LDML date format pattern "xxxxx".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ISO_EXTENDED_LOCAL_FULL,
    /**
     * Time Zone ID, such as "America/Los_Angeles".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ZONE_ID,
    /**
     * Short Time Zone ID (BCP 47 Unicode location extension, time zone type value), such as "uslax".
     * @stable ICU 51
     */
    UTZFMT_STYLE_ZONE_ID_SHORT,
    /**
     * Exemplar location, such as "Los Angeles" and "Paris".
     * @stable ICU 51
     */
    UTZFMT_STYLE_EXEMPLAR_LOCATION
} UTimeZoneFormatStyle;

/**
 * Constants for GMT offset pattern types.
 * @stable ICU 50
 */
typedef enum UTimeZoneFormatGMTOffsetPatternType {
    /**
     * Positive offset with hours and minutes fields
     * @stable ICU 50
     */
    UTZFMT_PAT_POSITIVE_HM,
    /**
     * Positive offset with hours, minutes and seconds fields
     * @stable ICU 50
     */
    UTZFMT_PAT_POSITIVE_HMS,
    /**
     * Negative offset with hours and minutes fields
     * @stable ICU 50
     */
    UTZFMT_PAT_NEGATIVE_HM,
    /**
     * Negative offset with hours, minutes and seconds fields
     * @stable ICU 50
     */
    UTZFMT_PAT_NEGATIVE_HMS,
    /**
     * Positive offset with hours field
     * @stable ICU 51
     */
    UTZFMT_PAT_POSITIVE_H,
    /**
     * Negative offset with hours field
     * @stable ICU 51
     */
    UTZFMT_PAT_NEGATIVE_H,

    /* The following cannot be #ifndef U_HIDE_INTERNAL_API, needed for other .h declarations */
    /**
     * Number of UTimeZoneFormatGMTOffsetPatternType types.
     * @internal
     */
    UTZFMT_PAT_COUNT = 6
} UTimeZoneFormatGMTOffsetPatternType;

/**
 * Constants for time types used by TimeZoneFormat APIs for
 * receiving time type (standard time, daylight time or unknown).
 * @stable ICU 50
 */
typedef enum UTimeZoneFormatTimeType {
    /**
     * Unknown
     * @stable ICU 50
     */
    UTZFMT_TIME_TYPE_UNKNOWN,
    /**
     * Standard time
     * @stable ICU 50
     */
    UTZFMT_TIME_TYPE_STANDARD,
    /**
     * Daylight saving time
     * @stable ICU 50
     */
    UTZFMT_TIME_TYPE_DAYLIGHT
} UTimeZoneFormatTimeType;

/**
 * Constants for parse option flags, used for specifying optional parse behavior.
 * @stable ICU 50
 */
typedef enum UTimeZoneFormatParseOption {
    /**
     * No option.
     * @stable ICU 50
     */
    UTZFMT_PARSE_OPTION_NONE        = 0x00,
    /**
     * When a time zone display name is not found within a set of display names
     * used for the specified style, look for the name from display names used
     * by other styles.
     * @stable ICU 50
     */
    UTZFMT_PARSE_OPTION_ALL_STYLES  = 0x01,
     /**
      * When parsing a time zone display name in \link UTZFMT_STYLE_SPECIFIC_SHORT \endlink,
      * look for the IANA tz database compatible zone abbreviations in addition
      * to the localized names coming from the icu::TimeZoneNames currently
      * used by the icu::TimeZoneFormat.
      * @stable ICU 54
      */
    UTZFMT_PARSE_OPTION_TZ_DATABASE_ABBREVIATIONS = 0x02
} UTimeZoneFormatParseOption;

U_CDECL_END

U_NAMESPACE_BEGIN

class TimeZoneGenericNames;
class TZDBTimeZoneNames;
class UVector;

/**
 * <code>TimeZoneFormat</code> supports time zone display name formatting and parsing.
 * An instance of TimeZoneFormat works as a subformatter of {@link SimpleDateFormat},
 * but you can also directly get a new instance of <code>TimeZoneFormat</code> and
 * formatting/parsing time zone display names.
 * <p>
 * ICU implements the time zone display names defined by <a href="http://www.unicode.org/reports/tr35/">UTS#35
 * Unicode Locale Data Markup Language (LDML)</a>. {@link TimeZoneNames} represents the
 * time zone display name data model and this class implements the algorithm for actual
 * formatting and parsing.
 *
 * @see SimpleDateFormat
 * @see TimeZoneNames
 * @stable ICU 50
 */
class U_I18N_API_CLASS TimeZoneFormat : public Format {
public:
    /**
     * Copy constructor.
     * @stable ICU 50
     */
    U_I18N_API TimeZoneFormat(const TimeZoneFormat& other);

    /**
     * Destructor.
     * @stable ICU 50
     */
    U_I18N_API virtual ~TimeZoneFormat();

    /**
     * Assignment operator.
     * @stable ICU 50
     */
    U_I18N_API TimeZoneFormat& operator=(const TimeZoneFormat& other);

    /**
     * Return true if the given Format objects are semantically equal.
     * Objects of different subclasses are considered unequal.
     * @param other The object to be compared with.
     * @return Return true if the given Format objects are semantically equal.
     *                Objects of different subclasses are considered unequal.
     * @stable ICU 50
     */
    U_I18N_API virtual bool operator==(const Format& other) const override;

    /**
     * Clone this object polymorphically. The caller is responsible
     * for deleting the result when done.
     * @return A copy of the object
     * @stable ICU 50
     */
    U_I18N_API virtual TimeZoneFormat* clone() const override;

    /**
     * Creates an instance of <code>TimeZoneFormat</code> for the given locale.
     * @param locale The locale.
     * @param status Receives the status.
     * @return An instance of <code>TimeZoneFormat</code> for the given locale,
     *          owned by the caller.
     * @stable ICU 50
     */
    U_I18N_API static TimeZoneFormat* U_EXPORT2 createInstance(const Locale& locale, UErrorCode& status);

    /**
     * Returns the time zone display name data used by this instance.
     * @return The time zone display name data.
     * @stable ICU 50
     */
    U_I18N_API const TimeZoneNames* getTimeZoneNames() const;

    /**
     * Sets the time zone display name data to this format instance.
     * The caller should not delete the TimeZoenNames object after it is adopted
     * by this call.
     * @param tznames TimeZoneNames object to be adopted.
     * @stable ICU 50
     */
    U_I18N_API void adoptTimeZoneNames(TimeZoneNames* tznames);

    /**
     * Sets the time zone display name data to this format instance.
     * @param tznames TimeZoneNames object to be set.
     * @stable ICU 50
     */
    U_I18N_API void setTimeZoneNames(const TimeZoneNames& tznames);

    /**
     * Returns the localized GMT format pattern.
     * @param pattern Receives the localized GMT format pattern.
     * @return A reference to the result pattern.
     * @see #setGMTPattern
     * @stable ICU 50
     */
    U_I18N_API UnicodeString& getGMTPattern(UnicodeString& pattern) const;

    /**
     * Sets the localized GMT format pattern. The pattern must contain
     * a single argument {0}, for example "GMT {0}".
     * @param pattern The localized GMT format pattern to be used by this object.
     * @param status Receives the status.
     * @see #getGMTPattern
     * @stable ICU 50
     */
    U_I18N_API void setGMTPattern(const UnicodeString& pattern, UErrorCode& status);

    /**
     * Returns the offset pattern used for localized GMT format.
     * @param type The offset pattern type enum.
     * @param pattern Receives the offset pattern.
     * @return A reference to the result pattern.
     * @see #setGMTOffsetPattern
     * @stable ICU 50
     */
    U_I18N_API UnicodeString& getGMTOffsetPattern(UTimeZoneFormatGMTOffsetPatternType type,
                                                  UnicodeString& pattern) const;

    /**
     * Sets the offset pattern for the given offset type.
     * @param type The offset pattern type enum.
     * @param pattern The offset pattern used for localized GMT format for the type.
     * @param status Receives the status.
     * @see #getGMTOffsetPattern
     * @stable ICU 50
     */
    U_I18N_API void setGMTOffsetPattern(UTimeZoneFormatGMTOffsetPatternType type,
                                        const UnicodeString& pattern, UErrorCode& status);

    /**
     * Returns the decimal digit characters used for localized GMT format.
     * The return string contains exactly 10 code points (may include Unicode
     * supplementary character) representing digit 0 to digit 9 in the ascending
     * order.
     * @param digits Receives the decimal digits used for localized GMT format.
     * @see #setGMTOffsetDigits
     * @stable ICU 50
     */
    U_I18N_API UnicodeString& getGMTOffsetDigits(UnicodeString& digits) const;

    /**
     * Sets the decimal digit characters used for localized GMT format.
     * The input <code>digits</code> must contain exactly 10 code points
     * (Unicode supplementary characters are also allowed) representing
     * digit 0 to digit 9 in the ascending order. When the input <code>digits</code>
     * does not satisfy the condition, <code>U_ILLEGAL_ARGUMENT_ERROR</code>
     * will be set to the return status.
     * @param digits The decimal digits used for localized GMT format.
     * @param status Receives the status.
     * @see #getGMTOffsetDigits
     * @stable ICU 50
     */
    U_I18N_API void setGMTOffsetDigits(const UnicodeString& digits, UErrorCode& status);

    /**
     * Returns the localized GMT format string for GMT(UTC) itself (GMT offset is 0).
     * @param gmtZeroFormat Receives the localized GMT string string for GMT(UTC) itself.
     * @return A reference to the result GMT string.
     * @see #setGMTZeroFormat
     * @stable ICU 50
     */
    U_I18N_API UnicodeString& getGMTZeroFormat(UnicodeString& gmtZeroFormat) const;

    /**
     * Sets the localized GMT format string for GMT(UTC) itself (GMT offset is 0).
     * @param gmtZeroFormat The localized GMT format string for GMT(UTC).
     * @param status Receives the status.
     * @see #getGMTZeroFormat
     * @stable ICU 50
     */
    U_I18N_API void setGMTZeroFormat(const UnicodeString& gmtZeroFormat, UErrorCode& status);

    /**
     * Returns the bitwise flags of UTimeZoneFormatParseOption representing the default parse
     * options used by this object.
     * @return the default parse options.
     * @see ParseOption
     * @stable ICU 50
     */
    U_I18N_API uint32_t getDefaultParseOptions() const;

    /**
     * Sets the default parse options.
     * <p><b>Note</b>: By default, an instance of <code>TimeZoneFormat</code>
     * created by {@link #createInstance} has no parse options set (UTZFMT_PARSE_OPTION_NONE).
     * To specify multiple options, use bitwise flags of UTimeZoneFormatParseOption.
     * @see #UTimeZoneFormatParseOption
     * @stable ICU 50
     */
    U_I18N_API void setDefaultParseOptions(uint32_t flags);

    /**
     * Returns the ISO 8601 basic time zone string for the given offset.
     * For example, "-08", "-0830" and "Z"
     *
     * @param offset the offset from GMT(UTC) in milliseconds.
     * @param useUtcIndicator true if ISO 8601 UTC indicator "Z" is used when the offset is 0.
     * @param isShort true if shortest form is used.
     * @param ignoreSeconds true if non-zero offset seconds is appended.
     * @param result Receives the ISO format string.
     * @param status Receives the status
     * @return the ISO 8601 basic format.
     * @see #formatOffsetISO8601Extended
     * @see #parseOffsetISO8601
     * @stable ICU 51
     */
    U_I18N_API UnicodeString& formatOffsetISO8601Basic(int32_t offset,
                                                       UBool useUtcIndicator,
                                                       UBool isShort,
                                                       UBool ignoreSeconds,
                                                       UnicodeString& result,
                                                       UErrorCode& status) const;

    /**
     * Returns the ISO 8601 extended time zone string for the given offset.
     * For example, "-08:00", "-08:30" and "Z"
     *
     * @param offset the offset from GMT(UTC) in milliseconds.
     * @param useUtcIndicator true if ISO 8601 UTC indicator "Z" is used when the offset is 0.
     * @param isShort true if shortest form is used.
     * @param ignoreSeconds true if non-zero offset seconds is appended.
     * @param result Receives the ISO format string.
     * @param status Receives the status
     * @return the ISO 8601 basic format.
     * @see #formatOffsetISO8601Extended
     * @see #parseOffsetISO8601
     * @stable ICU 51
     */
    U_I18N_API UnicodeString& formatOffsetISO8601Extended(int32_t offset,
                                                          UBool useUtcIndicator,
                                                          UBool isShort,
                                                          UBool ignoreSeconds,
                                                          UnicodeString& result,
                                                          UErrorCode& status) const;

    /**
     * Returns the localized GMT(UTC) offset format for the given offset.
     * The localized GMT offset is defined by;
     * <ul>
     * <li>GMT format pattern (e.g. "GMT {0}" - see {@link #getGMTPattern})
     * <li>Offset time pattern (e.g. "+HH:mm" - see {@link #getGMTOffsetPattern})
     * <li>Offset digits (e.g. "0123456789" - see {@link #getGMTOffsetDigits})
     * <li>GMT zero format (e.g. "GMT" - see {@link #getGMTZeroFormat})
     * </ul>
     * This format always uses 2 digit hours and minutes. When the given offset has non-zero
     * seconds, 2 digit seconds field will be appended. For example,
     * GMT+05:00 and GMT+05:28:06.
     * @param offset the offset from GMT(UTC) in milliseconds.
     * @param status Receives the status
     * @param result Receives the localized GMT format string.
     * @return A reference to the result.
     * @see #parseOffsetLocalizedGMT
     * @stable ICU 50
     */
    U_I18N_API UnicodeString& formatOffsetLocalizedGMT(int32_t offset,
                                                       UnicodeString& result,
                                                       UErrorCode& status) const;

    /**
     * Returns the short localized GMT(UTC) offset format for the given offset.
     * The short localized GMT offset is defined by;
     * <ul>
     * <li>GMT format pattern (e.g. "GMT {0}" - see {@link #getGMTPattern})
     * <li>Offset time pattern (e.g. "+HH:mm" - see {@link #getGMTOffsetPattern})
     * <li>Offset digits (e.g. "0123456789" - see {@link #getGMTOffsetDigits})
     * <li>GMT zero format (e.g. "GMT" - see {@link #getGMTZeroFormat})
     * </ul>
     * This format uses the shortest representation of offset. The hours field does not
     * have leading zero and lower fields with zero will be truncated. For example,
     * GMT+5 and GMT+530.
     * @param offset the offset from GMT(UTC) in milliseconds.
     * @param status Receives the status
     * @param result Receives the short localized GMT format string.
     * @return A reference to the result.
     * @see #parseOffsetShortLocalizedGMT
     * @stable ICU 51
     */
    U_I18N_API UnicodeString& formatOffsetShortLocalizedGMT(int32_t offset,
                                                            UnicodeString& result,
                                                            UErrorCode& status) const;

    using Format::format;

    /**
     * Returns the display name of the time zone at the given date for the style.
     * @param style The style (e.g. <code>UTZFMT_STYLE_GENERIC_LONG</code>, <code>UTZFMT_STYLE_LOCALIZED_GMT</code>...)
     * @param tz The time zone.
     * @param date The date.
     * @param name Receives the display name.
     * @param timeType the output argument for receiving the time type (standard/daylight/unknown)
     * used for the display name, or nullptr if the information is not necessary.
     * @return A reference to the result
     * @see #UTimeZoneFormatStyle
     * @see #UTimeZoneFormatTimeType
     * @stable ICU 50
     */
    U_I18N_API virtual UnicodeString& format(UTimeZoneFormatStyle style,
                                             const TimeZone& tz,
                                             UDate date,
                                             UnicodeString& name,
                                             UTimeZoneFormatTimeType* timeType = nullptr) const;

    /**
     * Returns offset from GMT(UTC) in milliseconds for the given ISO 8601
     * style time zone string. When the given string is not an ISO 8601 time zone
     * string, this method sets the current position as the error index
     * to <code>ParsePosition pos</code> and returns 0.
     * @param text The text contains ISO8601 style time zone string (e.g. "-08:00", "Z")
     *              at the position.
     * @param pos The ParsePosition object.
     * @return The offset from GMT(UTC) in milliseconds for the given ISO 8601 style
     *              time zone string.
     * @see #formatOffsetISO8601Basic
     * @see #formatOffsetISO8601Extended
     * @stable ICU 50
     */
    U_I18N_API int32_t parseOffsetISO8601(const UnicodeString& text, ParsePosition& pos) const;

    /**
     * Returns offset from GMT(UTC) in milliseconds for the given localized GMT
     * offset format string. When the given string cannot be parsed, this method
     * sets the current position as the error index to <code>ParsePosition pos</code>
     * and returns 0.
     * @param text The text contains a localized GMT offset string at the position.
     * @param pos The ParsePosition object.
     * @return The offset from GMT(UTC) in milliseconds for the given localized GMT
     *          offset format string.
     * @see #formatOffsetLocalizedGMT
     * @stable ICU 50
     */
    U_I18N_API int32_t parseOffsetLocalizedGMT(const UnicodeString& text, ParsePosition& pos) const;

    /**
     * Returns offset from GMT(UTC) in milliseconds for the given short localized GMT
     * offset format string. When the given string cannot be parsed, this method
     * sets the current position as the error index to <code>ParsePosition pos</code>
     * and returns 0.
     * @param text The text contains a short localized GMT offset string at the position.
     * @param pos The ParsePosition object.
     * @return The offset from GMT(UTC) in milliseconds for the given short localized GMT
     *          offset format string.
     * @see #formatOffsetShortLocalizedGMT
     * @stable ICU 51
     */
    U_I18N_API int32_t parseOffsetShortLocalizedGMT(const UnicodeString& text, ParsePosition& pos) const;

    /**
     * Returns a <code>TimeZone</code> by parsing the time zone string according to
     * the given parse position, the specified format style and parse options.
     *
     * @param text The text contains a time zone string at the position.
     * @param style The format style
     * @param pos The position.
     * @param parseOptions The parse options represented by bitwise flags of UTimeZoneFormatParseOption.
     * @param timeType The output argument for receiving the time type (standard/daylight/unknown),
     * or nullptr if the information is not necessary.
     * @return A <code>TimeZone</code>, or null if the input could not be parsed.
     * @see UTimeZoneFormatStyle
     * @see UTimeZoneFormatParseOption
     * @see UTimeZoneFormatTimeType
     * @stable ICU 50
     */
    U_I18N_API virtual TimeZone* parse(UTimeZoneFormatStyle style,
                                       const UnicodeString& text,
                                       ParsePosition& pos,
                                       int32_t parseOptions,
                                       UTimeZoneFormatTimeType* timeType = nullptr) const;

    /**
     * Returns a <code>TimeZone</code> by parsing the time zone string according to
     * the given parse position, the specified format style and the default parse options.
     *
     * @param text The text contains a time zone string at the position.
     * @param style The format style
     * @param pos The position.
     * @param timeType The output argument for receiving the time type (standard/daylight/unknown),
     * or nullptr if the information is not necessary.
     * @return A <code>TimeZone</code>, or null if the input could not be parsed.
     * @see UTimeZoneFormatStyle
     * @see UTimeZoneFormatParseOption
     * @see UTimeZoneFormatTimeType
     * @stable ICU 50
     */
    U_I18N_API TimeZone* parse(UTimeZoneFormatStyle style,
                               const UnicodeString& text,
                               ParsePosition& pos,
                               UTimeZoneFormatTimeType* timeType = nullptr) const;

    /* ----------------------------------------------
     * Format APIs
     * ---------------------------------------------- */

    /**
     * Format an object to produce a time zone display string using localized GMT offset format.
     * This method handles Formattable objects with a <code>TimeZone</code>. If a the Formattable
     * object type is not a <code>TimeZone</code>, then it returns a failing UErrorCode.
     * @param obj The object to format. Must be a <code>TimeZone</code>.
     * @param appendTo Output parameter to receive result. Result is appended to existing contents.
     * @param pos On input: an alignment field, if desired. On output: the offsets of the alignment field.
     * @param status Output param filled with success/failure status.
     * @return Reference to 'appendTo' parameter.
     * @stable ICU 50
     */
    U_I18N_API virtual UnicodeString& format(const Formattable& obj,
                                             UnicodeString& appendTo,
                                             FieldPosition& pos,
                                             UErrorCode& status) const override;

    /**
     * Parse a string to produce an object. This methods handles parsing of
     * time zone display strings into Formattable objects with <code>TimeZone</code>.
     * @param source The string to be parsed into an object.
     * @param result Formattable to be set to the parse result. If parse fails, return contents are undefined.
     * @param parse_pos The position to start parsing at. Upon return this param is set to the position after the
     *                  last character successfully parsed. If the source is not parsed successfully, this param
     *                  will remain unchanged.
     * @return A newly created Formattable* object, or nullptr on failure.  The caller owns this and should
     *                 delete it when done.
     * @stable ICU 50
     */
    U_I18N_API virtual void parseObject(const UnicodeString& source,
                                        Formattable& result,
                                        ParsePosition& parse_pos) const override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     * @stable ICU 50
     */
    U_I18N_API static UClassID getStaticClassID();

    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     * @stable ICU 50
     */
    U_I18N_API virtual UClassID getDynamicClassID() const override;

protected:
    /**
     * Constructs a TimeZoneFormat object for the specified locale.
     * @param locale the locale
     * @param status receives the status.
     * @stable ICU 50
     */
    U_I18N_API TimeZoneFormat(const Locale& locale, UErrorCode& status);

private:
    /* Locale of this object */
    Locale fLocale;

    /* Stores the region (could be implicit default) */
    char fTargetRegion[ULOC_COUNTRY_CAPACITY];

    /* TimeZoneNames object used by this formatter */
    TimeZoneNames* fTimeZoneNames;

    /* TimeZoneGenericNames object used by this formatter - lazily instantiated */
    TimeZoneGenericNames* fTimeZoneGenericNames;

    /* Localized GMT format pattern - e.g. "GMT{0}" */
    UnicodeString fGMTPattern;

    /* Array of offset patterns used by Localized GMT format - e.g. "+HH:mm" */
    UnicodeString fGMTOffsetPatterns[UTZFMT_PAT_COUNT];

    /* Localized decimal digits used by Localized GMT format */
    UChar32 fGMTOffsetDigits[10];

    /* Localized GMT zero format - e.g. "GMT" */
    UnicodeString fGMTZeroFormat;

    /* Bit flags representing parse options */
    uint32_t fDefParseOptionFlags;

    /* Constant parts of GMT format pattern, populated from localized GMT format pattern*/
    UnicodeString fGMTPatternPrefix;    /* Substring before {0} */
    UnicodeString fGMTPatternSuffix;    /* Substring after {0} */

    /* Compiled offset patterns generated from fGMTOffsetPatterns[] */
    UVector* fGMTOffsetPatternItems[UTZFMT_PAT_COUNT];

    UBool fAbuttingOffsetHoursAndMinutes;

    /* TZDBTimeZoneNames object used for parsing */
    TZDBTimeZoneNames* fTZDBTimeZoneNames;

    /**
     * Returns the time zone's specific format string.
     * @param tz the time zone
     * @param stdType the name type used for standard time
     * @param dstType the name type used for daylight time
     * @param date the date
     * @param name receives the time zone's specific format name string
     * @param timeType when null, actual time type is set
     * @return a reference to name.
     */
    UnicodeString& formatSpecific(const TimeZone& tz, UTimeZoneNameType stdType, UTimeZoneNameType dstType,
        UDate date, UnicodeString& name, UTimeZoneFormatTimeType *timeType) const;

    /**
     * Returns the time zone's generic format string.
     * @param tz the time zone
     * @param genType the generic name type
     * @param date the date
     * @param name receives the time zone's generic format name string
     * @return a reference to name.
     */
    UnicodeString& formatGeneric(const TimeZone& tz, int32_t genType, UDate date, UnicodeString& name) const;

    /**
     * Lazily create a TimeZoneGenericNames instance
     * @param status receives the status
     * @return the cached TimeZoneGenericNames.
     */
    const TimeZoneGenericNames* getTimeZoneGenericNames(UErrorCode& status) const;

    /**
     * Lazily create a TZDBTimeZoneNames instance
     * @param status receives the status
     * @return the cached TZDBTimeZoneNames.
     */
    const TZDBTimeZoneNames* getTZDBTimeZoneNames(UErrorCode& status) const;

    /**
     * Private method returning the time zone's exemplar location string.
     * This method will never return empty.
     * @param tz the time zone
     * @param name receives the time zone's exemplar location name
     * @return a reference to name.
     */
    UnicodeString& formatExemplarLocation(const TimeZone& tz, UnicodeString& name) const;

    /**
     * Private enum specifying a combination of offset fields
     */
    enum OffsetFields {
        FIELDS_H,
        FIELDS_HM,
        FIELDS_HMS
    };

    /**
     * Parses the localized GMT pattern string and initialize
     * localized gmt pattern fields.
     * @param gmtPattern the localized GMT pattern string such as "GMT {0}"
     * @param status U_ILLEGAL_ARGUMENT_ERROR is set when the specified pattern does not
     *               contain an argument "{0}".
     */
    void initGMTPattern(const UnicodeString& gmtPattern, UErrorCode& status);

    /**
     * Parse the GMT offset pattern into runtime optimized format.
     * @param pattern the offset pattern string
     * @param required the required set of fields, such as FIELDS_HM
     * @param status U_ILLEGAL_ARGUMENT is set when the specified pattern does not contain
     *               pattern letters for the required fields.
     * @return A list of GMTOffsetField objects, or nullptr on error.
     */
    static UVector* parseOffsetPattern(const UnicodeString& pattern, OffsetFields required, UErrorCode& status);

    /**
     * Appends seconds field to the offset pattern with hour/minute
     * Note: This code will be obsoleted once we add hour-minute-second pattern data in CLDR.
     * @param offsetHM the offset pattern including hours and minutes fields
     * @param result the output offset pattern including hour, minute and seconds fields
     * @param status receives the status
     * @return a reference to result
     */
    static UnicodeString& expandOffsetPattern(const UnicodeString& offsetHM, UnicodeString& result, UErrorCode& status);

    /**
     * Truncates minutes field to the offset pattern with hour/minute
     * Note: This code will be obsoleted once we add hour pattern data in CLDR.
     * @param offsetHM the offset pattern including hours and minutes fields
     * @param result the output offset pattern including only hours field
     * @param status receives the status
     * @return a reference to result
     */
    static UnicodeString& truncateOffsetPattern(const UnicodeString& offsetHM, UnicodeString& result, UErrorCode& status);

    /**
     * Break input string into UChar32[]. Each array element represents
     * a code point. This method is used for parsing localized digit
     * characters and support characters in Unicode supplemental planes.
     * @param str the string
     * @param codeArray receives the result
     * @param capacity the capacity of codeArray
     * @return true when the specified code array is fully filled with code points
     *         (no under/overflow).
     */
    static UBool toCodePoints(const UnicodeString& str, UChar32* codeArray, int32_t capacity);

    /**
     * Private method supprting all of ISO8601 formats
     * @param offset the offset from GMT(UTC) in milliseconds.
     * @param useUtcIndicator true if ISO 8601 UTC indicator "Z" is used when the offset is 0.
     * @param isShort true if shortest form is used.
     * @param ignoreSeconds true if non-zero offset seconds is appended.
     * @param result Receives the result
     * @param status Receives the status
     * @return the ISO 8601 basic format.
     */
    UnicodeString& formatOffsetISO8601(int32_t offset, UBool isBasic, UBool useUtcIndicator,
        UBool isShort, UBool ignoreSeconds, UnicodeString& result, UErrorCode& status) const;

    /**
     * Private method used for localized GMT formatting.
     * @param offset the zone's UTC offset
     * @param isShort true if the short localized GMT format is desired.
     * @param result receives the localized GMT format string
     * @param status receives the status
     */
    UnicodeString& formatOffsetLocalizedGMT(int32_t offset, UBool isShort, UnicodeString& result, UErrorCode& status) const;

    /**
     * Returns offset from GMT(UTC) in milliseconds for the given ISO 8601 style
     * (extended format) time zone string. When the given string is not an ISO 8601 time
     * zone string, this method sets the current position as the error index
     * to <code>ParsePosition pos</code> and returns 0.
     * @param text the text contains ISO 8601 style time zone string (e.g. "-08:00", "Z")
     *      at the position.
     * @param pos the position, non-negative error index will be set on failure.
     * @param extendedOnly true if parsing the text as ISO 8601 extended offset format (e.g. "-08:00"),
     *      or false to evaluate the text as basic format.
     * @param hasDigitOffset receiving if the parsed zone string contains offset digits.
     * @return the offset from GMT(UTC) in milliseconds for the given ISO 8601 style
     *      time zone string.
     */
    int32_t parseOffsetISO8601(const UnicodeString& text, ParsePosition& pos, UBool extendedOnly,
        UBool* hasDigitOffset = nullptr) const;

    /**
     * Appends localized digits to the buffer.
     * This code assumes that the input number is 0 - 59
     * @param buf the target buffer
     * @param n the integer number
     * @param minDigits the minimum digits width
     */
    void appendOffsetDigits(UnicodeString& buf, int32_t n, uint8_t minDigits) const;

    /**
     * Returns offset from GMT(UTC) in milliseconds for the given localized GMT
     * offset format string. When the given string cannot be parsed, this method
     * sets the current position as the error index to <code>ParsePosition pos</code>
     * and returns 0.
     * @param text the text contains a localized GMT offset string at the position.
     * @param pos the position, non-negative error index will be set on failure.
     * @param isShort true if this parser to try the short format first
     * @param hasDigitOffset receiving if the parsed zone string contains offset digits.
     * @return the offset from GMT(UTC) in milliseconds for the given localized GMT
     *      offset format string.
     */
    int32_t parseOffsetLocalizedGMT(const UnicodeString& text, ParsePosition& pos,
        UBool isShort, UBool* hasDigitOffset) const;

    /**
     * Parse localized GMT format generated by the patter used by this formatter, except
     * GMT Zero format.
     * @param text the input text
     * @param start the start index
     * @param isShort true if the short localized format is parsed.
     * @param parsedLen receives the parsed length
     * @return the parsed offset in milliseconds
     */
    int32_t parseOffsetLocalizedGMTPattern(const UnicodeString& text, int32_t start,
        UBool isShort, int32_t& parsedLen) const;

    /**
     * Parses localized GMT offset fields into offset.
     * @param text the input text
     * @param start the start index
     * @param isShort true if this is a short format - currently not used
     * @param parsedLen the parsed length, or 0 on failure.
     * @return the parsed offset in milliseconds.
     */
    int32_t parseOffsetFields(const UnicodeString& text, int32_t start, UBool isShort, int32_t& parsedLen) const;

    /**
     * Parse localized GMT offset fields with the given pattern.
     * @param text the input text
     * @param start the start index
     * @param pattenItems the pattern (already itemized)
     * @param forceSingleHourDigit true if hours field is parsed as a single digit
     * @param hour receives the hour offset field
     * @param min receives the minute offset field
     * @param sec receives the second offset field
     * @return the parsed length
     */
    int32_t parseOffsetFieldsWithPattern(const UnicodeString& text, int32_t start,
        UVector* patternItems, UBool forceSingleHourDigit, int32_t& hour, int32_t& min, int32_t& sec) const;

    /**
     * Parses abutting localized GMT offset fields (such as 0800) into offset.
     * @param text the input text
     * @param start the start index
     * @param parsedLen the parsed length, or 0 on failure
     * @return the parsed offset in milliseconds.
     */
    int32_t parseAbuttingOffsetFields(const UnicodeString& text, int32_t start, int32_t& parsedLen) const;

    /**
     * Parses the input text using the default format patterns (e.g. "UTC{0}").
     * @param text the input text
     * @param start the start index
     * @param parsedLen the parsed length, or 0 on failure
     * @return the parsed offset in milliseconds.
     */
    int32_t parseOffsetDefaultLocalizedGMT(const UnicodeString& text, int start, int32_t& parsedLen) const;

    /**
     * Parses the input GMT offset fields with the default offset pattern.
     * @param text the input text
     * @param start the start index
     * @param separator the separator character, e.g. ':'
     * @param parsedLen the parsed length, or 0 on failure.
     * @return the parsed offset in milliseconds.
     */
    int32_t parseDefaultOffsetFields(const UnicodeString& text, int32_t start, char16_t separator,
        int32_t& parsedLen) const;

    /**
     * Reads an offset field value. This method will stop parsing when
     * 1) number of digits reaches <code>maxDigits</code>
     * 2) just before already parsed number exceeds <code>maxVal</code>
     *
     * @param text the text
     * @param start the start offset
     * @param minDigits the minimum number of required digits
     * @param maxDigits the maximum number of digits
     * @param minVal the minimum value
     * @param maxVal the maximum value
     * @param parsedLen the actual parsed length.
     * @return the integer value parsed
     */
    int32_t parseOffsetFieldWithLocalizedDigits(const UnicodeString& text, int32_t start,
        uint8_t minDigits, uint8_t maxDigits, uint16_t minVal, uint16_t maxVal, int32_t& parsedLen) const;

    /**
     * Reads a single decimal digit, either localized digits used by this object
     * or any Unicode numeric character.
     * @param text the text
     * @param start the start index
     * @param len the actual length read from the text
     * the start index is not a decimal number.
     * @return the integer value of the parsed digit, or -1 on failure.
     */
    int32_t parseSingleLocalizedDigit(const UnicodeString& text, int32_t start, int32_t& len) const;

    /**
     * Formats offset using ASCII digits. The input offset range must be
     * within +/-24 hours (exclusive).
     * @param offset The offset
     * @param sep The field separator character or 0 if not required
     * @param minFields The minimum fields
     * @param maxFields The maximum fields
     * @return The offset string
     */
    static UnicodeString& formatOffsetWithAsciiDigits(int32_t offset, char16_t sep,
        OffsetFields minFields, OffsetFields maxFields, UnicodeString& result);

    /**
     * Parses offset represented by contiguous ASCII digits.
     * <p>
     * Note: This method expects the input position is already at the start of
     * ASCII digits and does not parse sign (+/-).
     * @param text The text contains a sequence of ASCII digits
     * @param pos The parse position
     * @param minFields The minimum Fields to be parsed
     * @param maxFields The maximum Fields to be parsed
     * @param fixedHourWidth true if hours field must be width of 2
     * @return Parsed offset, 0 or positive number.
     */
    static int32_t parseAbuttingAsciiOffsetFields(const UnicodeString& text, ParsePosition& pos,
        OffsetFields minFields, OffsetFields maxFields, UBool fixedHourWidth);

    /**
     * Parses offset represented by ASCII digits and separators.
     * <p>
     * Note: This method expects the input position is already at the start of
     * ASCII digits and does not parse sign (+/-).
     * @param text The text
     * @param pos The parse position
     * @param sep The separator character
     * @param minFields The minimum Fields to be parsed
     * @param maxFields The maximum Fields to be parsed
     * @return Parsed offset, 0 or positive number.
     */
    static int32_t parseAsciiOffsetFields(const UnicodeString& text, ParsePosition& pos, char16_t sep,
        OffsetFields minFields, OffsetFields maxFields);

    /**
     * Unquotes the message format style pattern.
     * @param pattern the pattern
     * @param result receive the unquoted pattern.
     * @return A reference to result.
     */
    static UnicodeString& unquote(const UnicodeString& pattern, UnicodeString& result);

    /**
     * Initialize localized GMT format offset hour/min/sec patterns.
     * This method parses patterns into optimized run-time format.
     * @param status receives the status.
     */
    void initGMTOffsetPatterns(UErrorCode& status);

    /**
     * Check if there are any GMT format offset patterns without
     * any separators between hours field and minutes field and update
     * fAbuttingOffsetHoursAndMinutes field. This method must be called
     * after all patterns are parsed into pattern items.
     */
    void checkAbuttingHoursAndMinutes();

    /**
     * Creates an instance of TimeZone for the given offset
     * @param offset the offset
     * @return A TimeZone with the given offset
     */
    TimeZone* createTimeZoneForOffset(int32_t offset) const;

    /**
     * Returns the time type for the given name type
     * @param nameType the name type
     * @return the time type (unknown/standard/daylight)
     */
    static UTimeZoneFormatTimeType getTimeType(UTimeZoneNameType nameType);

    /**
     * Returns the time zone ID of a match at the specified index within
     * the MatchInfoCollection.
     * @param matches the collection of matches
     * @param idx the index within matches
     * @param tzID receives the resolved time zone ID
     * @return a reference to tzID.
     */
    UnicodeString& getTimeZoneID(const TimeZoneNames::MatchInfoCollection* matches, int32_t idx, UnicodeString& tzID) const;


    /**
     * Parse a zone ID.
     * @param text the text contains a time zone ID string at the position.
     * @param pos the position
     * @param tzID receives the zone ID
     * @return a reference to tzID
     */
    UnicodeString& parseZoneID(const UnicodeString& text, ParsePosition& pos, UnicodeString& tzID) const;

    /**
     * Parse a short zone ID.
     * @param text the text contains a short time zone ID string at the position.
     * @param pos the position
     * @param tzID receives the short zone ID
     * @return a reference to tzID
     */
    UnicodeString& parseShortZoneID(const UnicodeString& text, ParsePosition& pos, UnicodeString& tzID) const;

    /**
     * Parse an exemplar location string.
     * @param text the text contains an exemplar location string at the position.
     * @param pos the position.
     * @param tzID receives the time zone ID
     * @return a reference to tzID
     */
    UnicodeString& parseExemplarLocation(const UnicodeString& text, ParsePosition& pos, UnicodeString& tzID) const;
};

U_NAMESPACE_END

#endif /* !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
