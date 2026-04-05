// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2007-2016, International Business Machines Corporation and
* others. All Rights Reserved.
*******************************************************************************
*
* File DTPTNGEN.H
*
*******************************************************************************
*/

#ifndef __DTPTNGEN_H__
#define __DTPTNGEN_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/datefmt.h"
#include "unicode/locid.h"
#include "unicode/udat.h"
#include "unicode/udatpg.h"
#include "unicode/unistr.h"

U_NAMESPACE_BEGIN

/**
 * \file
 * \brief C++ API: Date/Time Pattern Generator
 */


class CharString;
class Hashtable;
class FormatParser;
class DateTimeMatcher;
class DistanceInfo;
class PatternMap;
class PtnSkeleton;
class SharedDateTimePatternGenerator;

/**
 * This class provides flexible generation of date format patterns, like "yy-MM-dd".
 * The user can build up the generator by adding successive patterns. Once that
 * is done, a query can be made using a "skeleton", which is a pattern which just
 * includes the desired fields and lengths. The generator will return the "best fit"
 * pattern corresponding to that skeleton.
 * <p>The main method people will use is getBestPattern(String skeleton),
 * since normally this class is pre-built with data from a particular locale.
 * However, generators can be built directly from other data as well.
 * <p><i>Issue: may be useful to also have a function that returns the list of
 * fields in a pattern, in order, since we have that internally.
 * That would be useful for getting the UI order of field elements.</i>
 * @stable ICU 3.8
**/
class U_I18N_API_CLASS DateTimePatternGenerator : public UObject {
public:
    /**
     * Construct a flexible generator according to default locale.
     * @param status  Output param set to success/failure code on exit,
     *               which must not indicate a failure before the function call.
     * @stable ICU 3.8
     */
    U_I18N_API static DateTimePatternGenerator* createInstance(UErrorCode& status);

    /**
     * Construct a flexible generator according to data for a given locale.
     * @param uLocale
     * @param status  Output param set to success/failure code on exit,
     *               which must not indicate a failure before the function call.
     * @stable ICU 3.8
     */
    U_I18N_API static DateTimePatternGenerator* createInstance(const Locale& uLocale, UErrorCode& status);

#ifndef U_HIDE_INTERNAL_API

    /**
     * For ICU use only. Skips loading the standard date/time patterns (which is done via DateFormat).
     *
     * @internal
     */
    U_I18N_API static DateTimePatternGenerator* createInstanceNoStdPat(const Locale& uLocale,
                                                                       UErrorCode& status);

#endif /* U_HIDE_INTERNAL_API */

    /**
     * Create an empty generator, to be constructed with addPattern(...) etc.
     * @param status  Output param set to success/failure code on exit,
     *               which must not indicate a failure before the function call.
     * @stable ICU 3.8
     */
    U_I18N_API static DateTimePatternGenerator* createEmptyInstance(UErrorCode& status);

    /**
     * Destructor.
     * @stable ICU 3.8
     */
    U_I18N_API virtual ~DateTimePatternGenerator();

    /**
     * Clone DateTimePatternGenerator object. Clients are responsible for
     * deleting the DateTimePatternGenerator object cloned.
     * @stable ICU 3.8
     */
    U_I18N_API DateTimePatternGenerator* clone() const;

    /**
     * Return true if another object is semantically equal to this one.
     *
     * @param other    the DateTimePatternGenerator object to be compared with.
     * @return         true if other is semantically equal to this.
     * @stable ICU 3.8
     */
    U_I18N_API bool operator==(const DateTimePatternGenerator& other) const;

    /**
     * Return true if another object is semantically unequal to this one.
     *
     * @param other    the DateTimePatternGenerator object to be compared with.
     * @return         true if other is semantically unequal to this.
     * @stable ICU 3.8
     */
    U_I18N_API bool operator!=(const DateTimePatternGenerator& other) const;

    /**
     * Utility to return a unique skeleton from a given pattern. For example,
     * both "MMM-dd" and "dd/MMM" produce the skeleton "MMMdd".
     *
     * @param pattern   Input pattern, such as "dd/MMM"
     * @param status  Output param set to success/failure code on exit,
     *                  which must not indicate a failure before the function call.
     * @return skeleton such as "MMMdd"
     * @stable ICU 56
     */
    U_I18N_API static UnicodeString staticGetSkeleton(const UnicodeString& pattern, UErrorCode& status);

    /**
     * Utility to return a unique skeleton from a given pattern. For example,
     * both "MMM-dd" and "dd/MMM" produce the skeleton "MMMdd".
     * getSkeleton() works exactly like staticGetSkeleton().
     * Use staticGetSkeleton() instead of getSkeleton().
     *
     * @param pattern   Input pattern, such as "dd/MMM"
     * @param status  Output param set to success/failure code on exit,
     *                  which must not indicate a failure before the function call.
     * @return skeleton such as "MMMdd"
     * @stable ICU 3.8
     */
    U_I18N_API UnicodeString getSkeleton(const UnicodeString& pattern, UErrorCode& status); /* {
        The function is commented out because it is a stable API calling a draft API.
        After staticGetSkeleton becomes stable, staticGetSkeleton can be used and
        these comments and the definition of getSkeleton in dtptngen.cpp should be removed.
        return staticGetSkeleton(pattern, status);
    }*/

    /**
     * Utility to return a unique base skeleton from a given pattern. This is
     * the same as the skeleton, except that differences in length are minimized
     * so as to only preserve the difference between string and numeric form. So
     * for example, both "MMM-dd" and "d/MMM" produce the skeleton "MMMd"
     * (notice the single d).
     *
     * @param pattern  Input pattern, such as "dd/MMM"
     * @param status  Output param set to success/failure code on exit,
     *               which must not indicate a failure before the function call.
     * @return base skeleton, such as "MMMd"
     * @stable ICU 56
     */
    U_I18N_API static UnicodeString staticGetBaseSkeleton(const UnicodeString& pattern,
                                                          UErrorCode& status);

    /**
     * Utility to return a unique base skeleton from a given pattern. This is
     * the same as the skeleton, except that differences in length are minimized
     * so as to only preserve the difference between string and numeric form. So
     * for example, both "MMM-dd" and "d/MMM" produce the skeleton "MMMd"
     * (notice the single d).
     * getBaseSkeleton() works exactly like staticGetBaseSkeleton().
     * Use staticGetBaseSkeleton() instead of getBaseSkeleton().
     *
     * @param pattern  Input pattern, such as "dd/MMM"
     * @param status  Output param set to success/failure code on exit,
     *               which must not indicate a failure before the function call.
     * @return base skeleton, such as "MMMd"
     * @stable ICU 3.8
     */
    U_I18N_API UnicodeString getBaseSkeleton(const UnicodeString& pattern, UErrorCode& status); /* {
        The function is commented out because it is a stable API calling a draft API.
        After staticGetBaseSkeleton becomes stable, staticGetBaseSkeleton can be used and
        these comments and the definition of getBaseSkeleton in dtptngen.cpp should be removed.
        return staticGetBaseSkeleton(pattern, status);
    }*/

    /**
     * Adds a pattern to the generator. If the pattern has the same skeleton as
     * an existing pattern, and the override parameter is set, then the previous
     * value is overridden. Otherwise, the previous value is retained. In either
     * case, the conflicting status is set and previous vale is stored in
     * conflicting pattern.
     * <p>
     * Note that single-field patterns (like "MMM") are automatically added, and
     * don't need to be added explicitly!
     *
     * @param pattern   Input pattern, such as "dd/MMM"
     * @param override  When existing values are to be overridden use true,
     *                   otherwise use false.
     * @param conflictingPattern  Previous pattern with the same skeleton.
     * @param status  Output param set to success/failure code on exit,
     *               which must not indicate a failure before the function call.
     * @return conflicting status.  The value could be UDATPG_NO_CONFLICT,
     *                             UDATPG_BASE_CONFLICT or UDATPG_CONFLICT.
     * @stable ICU 3.8
     */
    U_I18N_API UDateTimePatternConflict addPattern(const UnicodeString& pattern,
                                                   UBool override,
                                                   UnicodeString& conflictingPattern,
                                                   UErrorCode& status);

#ifndef U_HIDE_INTERNAL_API
     /**
      * Like addPattern, but associates the pattern with the given skeleton.
      *
      * @internal ICU 78
      */
    U_I18N_API UDateTimePatternConflict addPatternWithSkeleton(const UnicodeString& pattern,
                                                               const UnicodeString& skeletonToUse,
                                                               UBool override,
                                                               UnicodeString& conflictingPattern,
                                                               UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * An AppendItem format is a pattern used to append a field if there is no
     * good match. For example, suppose that the input skeleton is "GyyyyMMMd",
     * and there is no matching pattern internally, but there is a pattern
     * matching "yyyyMMMd", say "d-MM-yyyy". Then that pattern is used, plus the
     * G. The way these two are conjoined is by using the AppendItemFormat for G
     * (era). So if that value is, say "{0}, {1}" then the final resulting
     * pattern is "d-MM-yyyy, G".
     * <p>
     * There are actually three available variables: {0} is the pattern so far,
     * {1} is the element we are adding, and {2} is the name of the element.
     * <p>
     * This reflects the way that the CLDR data is organized.
     *
     * @param field  such as UDATPG_ERA_FIELD.
     * @param value  pattern, such as "{0}, {1}"
     * @stable ICU 3.8
     */
    U_I18N_API void setAppendItemFormat(UDateTimePatternField field, const UnicodeString& value);

    /**
     * Getter corresponding to setAppendItemFormat. Values below 0 or at or
     * above UDATPG_FIELD_COUNT are illegal arguments.
     *
     * @param  field  such as UDATPG_ERA_FIELD.
     * @return append pattern for field
     * @stable ICU 3.8
     */
    U_I18N_API const UnicodeString& getAppendItemFormat(UDateTimePatternField field) const;

    /**
     * Sets the names of field, eg "era" in English for ERA. These are only
     * used if the corresponding AppendItemFormat is used, and if it contains a
     * {2} variable.
     * <p>
     * This reflects the way that the CLDR data is organized.
     *
     * @param field   such as UDATPG_ERA_FIELD.
     * @param value   name of the field
     * @stable ICU 3.8
     */
    U_I18N_API void setAppendItemName(UDateTimePatternField field, const UnicodeString& value);

    /**
     * Getter corresponding to setAppendItemNames. Values below 0 or at or above
     * UDATPG_FIELD_COUNT are illegal arguments. Note: The more general method
     * for getting date/time field display names is getFieldDisplayName.
     *
     * @param field  such as UDATPG_ERA_FIELD.
     * @return name for field
     * @see getFieldDisplayName
     * @stable ICU 3.8
     */
    U_I18N_API const UnicodeString& getAppendItemName(UDateTimePatternField field) const;

    /**
     * The general interface to get a display name for a particular date/time field,
     * in one of several possible display widths.
     *
     * @param field  The desired UDateTimePatternField, such as UDATPG_ERA_FIELD.
     * @param width  The desired UDateTimePGDisplayWidth, such as UDATPG_ABBREVIATED.
     * @return       The display name for field
     * @stable ICU 61
     */
    U_I18N_API UnicodeString getFieldDisplayName(UDateTimePatternField field,
                                                 UDateTimePGDisplayWidth width) const;

    /**
     * The DateTimeFormat is a message format pattern used to compose date and
     * time patterns. The default pattern in the root locale is "{1} {0}", where
     * {1} will be replaced by the date pattern and {0} will be replaced by the
     * time pattern; however, other locales may specify patterns such as
     * "{1}, {0}" or "{1} 'at' {0}", etc.
     * <p>
     * This is used when the input skeleton contains both date and time fields,
     * but there is not a close match among the added patterns. For example,
     * suppose that this object was created by adding "dd-MMM" and "hh:mm", and
     * its datetimeFormat is the default "{1} {0}". Then if the input skeleton
     * is "MMMdhmm", there is not an exact match, so the input skeleton is
     * broken up into two components "MMMd" and "hmm". There are close matches
     * for those two skeletons, so the result is put together with this pattern,
     * resulting in "d-MMM h:mm".
     *
     * There are four DateTimeFormats in a DateTimePatternGenerator object,
     * corresponding to date styles UDAT_FULL..UDAT_SHORT. This method sets
     * all of them to the specified pattern. To set them individually, see
     * setDateTimeFormat(UDateFormatStyle style, ...).
     *
     * @param dateTimeFormat
     *            message format pattern, here {1} will be replaced by the date
     *            pattern and {0} will be replaced by the time pattern.
     * @stable ICU 3.8
     */
    U_I18N_API void setDateTimeFormat(const UnicodeString& dateTimeFormat);

    /**
     * Getter corresponding to setDateTimeFormat.
     *
     * There are four DateTimeFormats in a DateTimePatternGenerator object,
     * corresponding to date styles UDAT_FULL..UDAT_SHORT. This method gets
     * the style for UDAT_MEDIUM (the default). To get them individually, see
     * getDateTimeFormat(UDateFormatStyle style).
     *
     * @return DateTimeFormat.
     * @stable ICU 3.8
     */
    U_I18N_API const UnicodeString& getDateTimeFormat() const;

#if !UCONFIG_NO_FORMATTING
    /**
     * dateTimeFormats are message patterns used to compose combinations of date
     * and time patterns. There are four length styles, corresponding to the
     * inferred style of the date pattern; these are UDateFormatStyle values:
     *  - UDAT_FULL (for date pattern with weekday and long month), else
     *  - UDAT_LONG (for a date pattern with long month), else
     *  - UDAT_MEDIUM (for a date pattern with abbreviated month), else
     *  - UDAT_SHORT (for any other date pattern).
     * For details on dateTimeFormats, see
     * https://www.unicode.org/reports/tr35/tr35-dates.html#dateTimeFormats.
     * The default pattern in the root locale for all styles is "{1} {0}".
     *
     * @param style
     *              one of DateFormat.FULL..DateFormat.SHORT. Error if out of range.
     * @param dateTimeFormat
     *              the new dateTimeFormat to set for the specified style
     * @param status
     *              in/out parameter; if no failure status is already set,
     *              it will be set according to result of the function (e.g.
     *              U_ILLEGAL_ARGUMENT_ERROR for style out of range).
     * @stable ICU 71
     */
    U_I18N_API void setDateTimeFormat(UDateFormatStyle style,
                                      const UnicodeString& dateTimeFormat,
                                      UErrorCode& status);

    /**
     * Getter corresponding to setDateTimeFormat.
     *
     * @param style
     *              one of UDAT_FULL..UDAT_SHORT. Error if out of range.
     * @param status
     *              in/out parameter; if no failure status is already set,
     *              it will be set according to result of the function (e.g.
     *              U_ILLEGAL_ARGUMENT_ERROR for style out of range).
     * @return
     *              the current dateTimeFormat for the specified style, or
     *              empty string in case of error. The UnicodeString reference,
     *              or the contents of the string, may no longer be valid if
     *              setDateTimeFormat is called, or the DateTimePatternGenerator
     *              object is deleted.
     * @stable ICU 71
     */
    U_I18N_API const UnicodeString& getDateTimeFormat(UDateFormatStyle style, UErrorCode& status) const;
#endif /* #if !UCONFIG_NO_FORMATTING */

    /**
     * Return the best pattern matching the input skeleton. It is guaranteed to
     * have all of the fields in the skeleton.
     *
     * @param skeleton
     *            The skeleton is a pattern containing only the variable fields.
     *            For example, "MMMdd" and "mmhh" are skeletons.
     * @param status  Output param set to success/failure code on exit,
     *               which must not indicate a failure before the function call.
     * @return bestPattern
     *            The best pattern found from the given skeleton.
     * @stable ICU 3.8
     */
    U_I18N_API UnicodeString getBestPattern(const UnicodeString& skeleton, UErrorCode& status);

    /**
     * Return the best pattern matching the input skeleton. It is guaranteed to
     * have all of the fields in the skeleton.
     *
     * @param skeleton
     *            The skeleton is a pattern containing only the variable fields.
     *            For example, "MMMdd" and "mmhh" are skeletons.
     * @param options
     *            Options for forcing the length of specified fields in the
     *            returned pattern to match those in the skeleton (when this
     *            would not happen otherwise). For default behavior, use
     *            UDATPG_MATCH_NO_OPTIONS.
     * @param status
     *            Output param set to success/failure code on exit,
     *            which must not indicate a failure before the function call.
     * @return bestPattern
     *            The best pattern found from the given skeleton.
     * @stable ICU 4.4
     */
    U_I18N_API UnicodeString getBestPattern(const UnicodeString& skeleton,
                                            UDateTimePatternMatchOptions options,
                                            UErrorCode& status);

    /**
     * Adjusts the field types (width and subtype) of a pattern to match what is
     * in a skeleton. That is, if you supply a pattern like "d-M H:m", and a
     * skeleton of "MMMMddhhmm", then the input pattern is adjusted to be
     * "dd-MMMM hh:mm". This is used internally to get the best match for the
     * input skeleton, but can also be used externally.
     *
     * @param pattern Input pattern
     * @param skeleton
     *            The skeleton is a pattern containing only the variable fields.
     *            For example, "MMMdd" and "mmhh" are skeletons.
     * @param status  Output param set to success/failure code on exit,
     *               which must not indicate a failure before the function call.
     * @return pattern adjusted to match the skeleton fields widths and subtypes.
     * @stable ICU 3.8
     */
    U_I18N_API UnicodeString replaceFieldTypes(const UnicodeString& pattern,
                                               const UnicodeString& skeleton,
                                               UErrorCode& status);

    /**
     * Adjusts the field types (width and subtype) of a pattern to match what is
     * in a skeleton. That is, if you supply a pattern like "d-M H:m", and a
     * skeleton of "MMMMddhhmm", then the input pattern is adjusted to be
     * "dd-MMMM hh:mm". This is used internally to get the best match for the
     * input skeleton, but can also be used externally.
     *
     * @param pattern Input pattern
     * @param skeleton
     *            The skeleton is a pattern containing only the variable fields.
     *            For example, "MMMdd" and "mmhh" are skeletons.
     * @param options
     *            Options controlling whether the length of specified fields in the
     *            pattern are adjusted to match those in the skeleton (when this
     *            would not happen otherwise). For default behavior, use
     *            UDATPG_MATCH_NO_OPTIONS.
     * @param status
     *            Output param set to success/failure code on exit,
     *            which must not indicate a failure before the function call.
     * @return pattern adjusted to match the skeleton fields widths and subtypes.
     * @stable ICU 4.4
     */
    U_I18N_API UnicodeString replaceFieldTypes(const UnicodeString& pattern,
                                               const UnicodeString& skeleton,
                                               UDateTimePatternMatchOptions options,
                                               UErrorCode& status);

    /**
     * Return a list of all the skeletons (in canonical form) from this class.
     *
     * Call getPatternForSkeleton() to get the corresponding pattern.
     *
     * @param status  Output param set to success/failure code on exit,
     *               which must not indicate a failure before the function call.
     * @return StringEnumeration with the skeletons.
     *         The caller must delete the object.
     * @stable ICU 3.8
     */
    U_I18N_API StringEnumeration* getSkeletons(UErrorCode& status) const;

    /**
     * Get the pattern corresponding to a given skeleton.
     * @param skeleton
     * @return pattern corresponding to a given skeleton.
     * @stable ICU 3.8
     */
    U_I18N_API const UnicodeString& getPatternForSkeleton(const UnicodeString& skeleton) const;

    /**
     * Return a list of all the base skeletons (in canonical form) from this class.
     *
     * @param status  Output param set to success/failure code on exit,
     *               which must not indicate a failure before the function call.
     * @return a StringEnumeration with the base skeletons.
     *         The caller must delete the object.
     * @stable ICU 3.8
     */
    U_I18N_API StringEnumeration* getBaseSkeletons(UErrorCode& status) const;

#ifndef U_HIDE_INTERNAL_API
     /**
      * Return a list of redundant patterns are those which if removed, make no
      * difference in the resulting getBestPattern values. This method returns a
      * list of them, to help check the consistency of the patterns used to build
      * this generator.
      *
      * @param status  Output param set to success/failure code on exit,
      *               which must not indicate a failure before the function call.
      * @return a StringEnumeration with the redundant pattern.
      *         The caller must delete the object.
      * @internal ICU 3.8
      */
    U_I18N_API StringEnumeration* getRedundants(UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * The decimal value is used in formatting fractions of seconds. If the
     * skeleton contains fractional seconds, then this is used with the
     * fractional seconds. For example, suppose that the input pattern is
     * "hhmmssSSSS", and the best matching pattern internally is "H:mm:ss", and
     * the decimal string is ",". Then the resulting pattern is modified to be
     * "H:mm:ss,SSSS"
     *
     * @param decimal
     * @stable ICU 3.8
     */
    U_I18N_API void setDecimal(const UnicodeString& decimal);

    /**
     * Getter corresponding to setDecimal.
     * @return UnicodeString corresponding to the decimal point
     * @stable ICU 3.8
     */
    U_I18N_API const UnicodeString& getDecimal() const;

#if !UCONFIG_NO_FORMATTING

    /**
     * Get the default hour cycle for a locale. Uses the locale that the
     * DateTimePatternGenerator was initially created with.
     * 
     * Cannot be used on an empty DateTimePatternGenerator instance.
     * 
     * @param status  Output param set to success/failure code on exit, which
     *                which must not indicate a failure before the function call.
     *                Set to U_UNSUPPORTED_ERROR if used on an empty instance.
     * @return the default hour cycle.
     * @stable ICU 67
     */
    U_I18N_API UDateFormatHourCycle getDefaultHourCycle(UErrorCode& status) const;

#endif /* #if !UCONFIG_NO_FORMATTING */
    
    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 3.8
     */
    U_I18N_API virtual UClassID getDynamicClassID() const override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 3.8
     */
    U_I18N_API static UClassID getStaticClassID();

private:
    /**
     * Constructor.
     */
    DateTimePatternGenerator(UErrorCode & status);

    /**
     * Constructor.
     */
    DateTimePatternGenerator(const Locale& locale, UErrorCode & status, UBool skipStdPatterns = false);

    /**
     * Copy constructor.
     * @param other DateTimePatternGenerator to copy
     */
    DateTimePatternGenerator(const DateTimePatternGenerator& other);

    /**
     * Default assignment operator.
     * @param other DateTimePatternGenerator to copy
     */
    DateTimePatternGenerator& operator=(const DateTimePatternGenerator& other);

    static const int32_t UDATPG_WIDTH_COUNT = UDATPG_NARROW + 1;

    Locale pLocale;  // pattern locale
    FormatParser *fp;
    DateTimeMatcher* dtMatcher;
    DistanceInfo *distanceInfo;
    PatternMap *patternMap;
    UnicodeString appendItemFormats[UDATPG_FIELD_COUNT];
    UnicodeString fieldDisplayNames[UDATPG_FIELD_COUNT][UDATPG_WIDTH_COUNT];
    UnicodeString dateTimeFormat[4];
    UnicodeString decimal;
    DateTimeMatcher *skipMatcher;
    Hashtable *fAvailableFormatKeyHash;
    UnicodeString emptyString;
    char16_t fDefaultHourFormatChar;

    int32_t fAllowedHourFormats[7];  // Actually an array of AllowedHourFormat enum type, ending with UNKNOWN.

    // Internal error code used for recording/reporting errors that occur during methods that do not
    // have a UErrorCode parameter. For example: the Copy Constructor, or the ::clone() method.
    // When this is set to an error the object is in an invalid state.
    UErrorCode internalErrorCode;

    /* internal flags masks for adjustFieldTypes etc. */
    enum {
        kDTPGNoFlags = 0,
        kDTPGFixFractionalSeconds = 1,
        kDTPGSkeletonUsesCapJ = 2
        // with #13183, no longer need flags for b, B
    };

    void initData(const Locale &locale, UErrorCode &status, UBool skipStdPatterns = false);
    void addCanonicalItems(UErrorCode &status);
    void addICUPatterns(const Locale& locale, UErrorCode& status);
    void hackTimes(const UnicodeString& hackPattern, UErrorCode& status);
    void getCalendarTypeToUse(const Locale& locale, CharString& destination, UErrorCode& err);
    void consumeShortTimePattern(const UnicodeString& shortTimePattern, UErrorCode& status);
    void addCLDRData(const Locale& locale, UErrorCode& status);
    UDateTimePatternConflict addPatternWithOptionalSkeleton(const UnicodeString& pattern, const UnicodeString * skeletonToUse, UBool override, UnicodeString& conflictingPattern, UErrorCode& status);
    void initHashtable(UErrorCode& status);
    void setDateTimeFromCalendar(const Locale& locale, UErrorCode& status);
    void setDecimalSymbols(const Locale& locale, UErrorCode& status);
    UDateTimePatternField getAppendFormatNumber(const char* field) const;
    // Note for the next 3: UDateTimePGDisplayWidth is now stable ICU 61
    UDateTimePatternField getFieldAndWidthIndices(const char* key, UDateTimePGDisplayWidth* widthP) const;
    void setFieldDisplayName(UDateTimePatternField field, UDateTimePGDisplayWidth width, const UnicodeString& value);
    UnicodeString& getMutableFieldDisplayName(UDateTimePatternField field, UDateTimePGDisplayWidth width);
    void getAppendName(UDateTimePatternField field, UnicodeString& value);
    UnicodeString mapSkeletonMetacharacters(const UnicodeString& patternForm, int32_t* flags, UErrorCode& status);
    const UnicodeString* getBestRaw(DateTimeMatcher& source, int32_t includeMask, DistanceInfo* missingFields, UErrorCode& status, const PtnSkeleton** specifiedSkeletonPtr = nullptr);
    UnicodeString adjustFieldTypes(const UnicodeString& pattern, const PtnSkeleton* specifiedSkeleton, int32_t flags, UDateTimePatternMatchOptions options = UDATPG_MATCH_NO_OPTIONS);
    UnicodeString getBestAppending(int32_t missingFields, int32_t flags, UErrorCode& status, UDateTimePatternMatchOptions options = UDATPG_MATCH_NO_OPTIONS);
    int32_t getTopBitNumber(int32_t foundMask) const;
    void setAvailableFormat(const UnicodeString &key, UErrorCode& status);
    UBool isAvailableFormatSet(const UnicodeString &key) const;
    void copyHashtable(Hashtable *other, UErrorCode &status);
    UBool isCanonicalItem(const UnicodeString& item) const;
    static void U_CALLCONV loadAllowedHourFormatsData(UErrorCode &status);
    void getAllowedHourFormats(const Locale &locale, UErrorCode &status);

    struct U_HIDDEN AppendItemFormatsSink;
    struct U_HIDDEN AppendItemNamesSink;
    struct U_HIDDEN AvailableFormatsSink;
} ;// end class DateTimePatternGenerator

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
