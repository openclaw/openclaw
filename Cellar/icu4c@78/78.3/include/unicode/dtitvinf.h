// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 *******************************************************************************
 * Copyright (C) 2008-2016, International Business Machines Corporation and
 * others. All Rights Reserved.
 *******************************************************************************
 *
 * File DTITVINF.H
 *
 *******************************************************************************
 */

#ifndef __DTITVINF_H__
#define __DTITVINF_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C++ API: Date/Time interval patterns for formatting date/time interval
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/udat.h"
#include "unicode/locid.h"
#include "unicode/ucal.h"
#include "unicode/dtptngen.h"

U_NAMESPACE_BEGIN

/**
 * DateIntervalInfo is a public class for encapsulating localizable
 * date time interval patterns. It is used by DateIntervalFormat.
 *
 * <P>
 * For most users, ordinary use of DateIntervalFormat does not need to create
 * DateIntervalInfo object directly.
 * DateIntervalFormat will take care of it when creating a date interval
 * formatter when user pass in skeleton and locale.
 *
 * <P>
 * For power users, who want to create their own date interval patterns,
 * or want to re-set date interval patterns, they could do so by
 * directly creating DateIntervalInfo and manipulating it.
 *
 * <P>
 * Logically, the interval patterns are mappings
 * from (skeleton, the_largest_different_calendar_field)
 * to (date_interval_pattern).
 *
 * <P>
 * A skeleton
 * <ol>
 * <li>
 * only keeps the field pattern letter and ignores all other parts
 * in a pattern, such as space, punctuations, and string literals.
 * <li>
 * hides the order of fields.
 * <li>
 * might hide a field's pattern letter length.
 *
 * For those non-digit calendar fields, the pattern letter length is
 * important, such as MMM, MMMM, and MMMMM; EEE and EEEE,
 * and the field's pattern letter length is honored.
 *
 * For the digit calendar fields,  such as M or MM, d or dd, yy or yyyy,
 * the field pattern length is ignored and the best match, which is defined
 * in date time patterns, will be returned without honor the field pattern
 * letter length in skeleton.
 * </ol>
 *
 * <P>
 * The calendar fields we support for interval formatting are:
 * year, month, date, day-of-week, am-pm, hour, hour-of-day, and minute.
 * Those calendar fields can be defined in the following order:
 * year >  month > date > am-pm > hour >  minute
 *
 * The largest different calendar fields between 2 calendars is the
 * first different calendar field in above order.
 *
 * For example: the largest different calendar fields between &quot;Jan 10, 2007&quot;
 * and &quot;Feb 20, 2008&quot; is year.
 *
 * <P>
 * There is a set of pre-defined static skeleton strings.
 * There are pre-defined interval patterns for those pre-defined skeletons
 * in locales' resource files.
 * For example, for a skeleton UDAT_YEAR_ABBR_MONTH_DAY, which is  &quot;yMMMd&quot;,
 * in  en_US, if the largest different calendar field between date1 and date2
 * is &quot;year&quot;, the date interval pattern  is &quot;MMM d, yyyy - MMM d, yyyy&quot;,
 * such as &quot;Jan 10, 2007 - Jan 10, 2008&quot;.
 * If the largest different calendar field between date1 and date2 is &quot;month&quot;,
 * the date interval pattern is &quot;MMM d - MMM d, yyyy&quot;,
 * such as &quot;Jan 10 - Feb 10, 2007&quot;.
 * If the largest different calendar field between date1 and date2 is &quot;day&quot;,
 * the date interval pattern is &quot;MMM d-d, yyyy&quot;, such as &quot;Jan 10-20, 2007&quot;.
 *
 * For date skeleton, the interval patterns when year, or month, or date is
 * different are defined in resource files.
 * For time skeleton, the interval patterns when am/pm, or hour, or minute is
 * different are defined in resource files.
 *
 *
 * <P>
 * There are 2 dates in interval pattern. For most locales, the first date
 * in an interval pattern is the earlier date. There might be a locale in which
 * the first date in an interval pattern is the later date.
 * We use fallback format for the default order for the locale.
 * For example, if the fallback format is &quot;{0} - {1}&quot;, it means
 * the first date in the interval pattern for this locale is earlier date.
 * If the fallback format is &quot;{1} - {0}&quot;, it means the first date is the
 * later date.
 * For a particular interval pattern, the default order can be overridden
 * by prefixing &quot;latestFirst:&quot; or &quot;earliestFirst:&quot; to the interval pattern.
 * For example, if the fallback format is &quot;{0}-{1}&quot;,
 * but for skeleton &quot;yMMMd&quot;, the interval pattern when day is different is
 * &quot;latestFirst:d-d MMM yy&quot;, it means by default, the first date in interval
 * pattern is the earlier date. But for skeleton &quot;yMMMd&quot;, when day is different,
 * the first date in &quot;d-d MMM yy&quot; is the later date.
 *
 * <P>
 * The recommended way to create a DateIntervalFormat object is to pass in
 * the locale.
 * By using a Locale parameter, the DateIntervalFormat object is
 * initialized with the pre-defined interval patterns for a given or
 * default locale.
 * <P>
 * Users can also create DateIntervalFormat object
 * by supplying their own interval patterns.
 * It provides flexibility for power users.
 *
 * <P>
 * After a DateIntervalInfo object is created, clients may modify
 * the interval patterns using setIntervalPattern function as so desired.
 * Currently, users can only set interval patterns when the following
 * calendar fields are different: ERA, YEAR, MONTH, DATE, DAY_OF_MONTH,
 * DAY_OF_WEEK, AM_PM, HOUR, HOUR_OF_DAY, MINUTE, SECOND, and MILLISECOND.
 * Interval patterns when other calendar fields are different is not supported.
 * <P>
 * DateIntervalInfo objects are cloneable.
 * When clients obtain a DateIntervalInfo object,
 * they can feel free to modify it as necessary.
 * <P>
 * DateIntervalInfo are not expected to be subclassed.
 * Data for a calendar is loaded out of resource bundles.
 * Through ICU 4.4, date interval patterns are only supported in the Gregorian
 * calendar; non-Gregorian calendars are supported from ICU 4.4.1.
 * @stable ICU 4.0
**/
class U_I18N_API DateIntervalInfo final : public UObject {
public:
    /**
     * Default constructor.
     * It does not initialize any interval patterns except
     * that it initialize default fall-back pattern as "{0} - {1}",
     * which can be reset by setFallbackIntervalPattern().
     * It should be followed by setFallbackIntervalPattern() and
     * setIntervalPattern(),
     * and is recommended to be used only for power users who
     * wants to create their own interval patterns and use them to create
     * date interval formatter.
     * @param status   output param set to success/failure code on exit
     * @internal ICU 4.0
     */
    DateIntervalInfo(UErrorCode& status);


    /**
     * Construct DateIntervalInfo for the given locale,
     * @param locale  the interval patterns are loaded from the appropriate calendar
     *                data (specified calendar or default calendar) in this locale.
     * @param status  output param set to success/failure code on exit
     * @stable ICU 4.0
     */
    DateIntervalInfo(const Locale& locale, UErrorCode& status);


    /**
     * Copy constructor.
     * @stable ICU 4.0
     */
    DateIntervalInfo(const DateIntervalInfo&);

    /**
     * Assignment operator
     * @stable ICU 4.0
     */
    DateIntervalInfo& operator=(const DateIntervalInfo&);

    /**
     * Clone this object polymorphically.
     * The caller owns the result and should delete it when done.
     * @return   a copy of the object
     * @stable ICU 4.0
     */
    DateIntervalInfo* clone() const;

    /**
     * Destructor.
     * @stable ICU 4.0
     */
    ~DateIntervalInfo();


    /**
     * Return true if another object is semantically equal to this one.
     *
     * @param other    the DateIntervalInfo object to be compared with.
     * @return         true if other is semantically equal to this.
     * @stable ICU 4.0
     */
    bool operator==(const DateIntervalInfo& other) const;

    /**
     * Return true if another object is semantically unequal to this one.
     *
     * @param other    the DateIntervalInfo object to be compared with.
     * @return         true if other is semantically unequal to this.
     * @stable ICU 4.0
     */
    bool operator!=(const DateIntervalInfo& other) const;



    /**
     * Provides a way for client to build interval patterns.
     * User could construct DateIntervalInfo by providing a list of skeletons
     * and their patterns.
     * <P>
     * For example:
     * <pre>
     * UErrorCode status = U_ZERO_ERROR;
     * DateIntervalInfo dIntervalInfo = new DateIntervalInfo();
     * dIntervalInfo->setFallbackIntervalPattern("{0} ~ {1}");
     * dIntervalInfo->setIntervalPattern("yMd", UCAL_YEAR, "'from' yyyy-M-d 'to' yyyy-M-d", status);
     * dIntervalInfo->setIntervalPattern("yMMMd", UCAL_MONTH, "'from' yyyy MMM d 'to' MMM d", status);
     * dIntervalInfo->setIntervalPattern("yMMMd", UCAL_DAY, "yyyy MMM d-d", status, status);
     * </pre>
     *
     * Restriction:
     * Currently, users can only set interval patterns when the following
     * calendar fields are different: ERA, YEAR, MONTH, DATE,  DAY_OF_MONTH,
     * DAY_OF_WEEK, AM_PM,  HOUR, HOUR_OF_DAY, MINUTE, SECOND and MILLISECOND.
     * Interval patterns when other calendar fields are different are
     * not supported.
     *
     * @param skeleton         the skeleton on which interval pattern based
     * @param lrgDiffCalUnit   the largest different calendar unit.
     * @param intervalPattern  the interval pattern on the largest different
     *                         calendar unit.
     *                         For example, if lrgDiffCalUnit is
     *                         "year", the interval pattern for en_US when year
     *                         is different could be "'from' yyyy 'to' yyyy".
     * @param status           output param set to success/failure code on exit
     * @stable ICU 4.0
     */
    void setIntervalPattern(const UnicodeString& skeleton,
                            UCalendarDateFields lrgDiffCalUnit,
                            const UnicodeString& intervalPattern,
                            UErrorCode& status);

    /**
     * Get the interval pattern given skeleton and
     * the largest different calendar field.
     * @param skeleton   the skeleton
     * @param field      the largest different calendar field
     * @param result     output param to receive the pattern
     * @param status     output param set to success/failure code on exit
     * @return a reference to 'result'
     * @stable ICU 4.0
     */
    UnicodeString& getIntervalPattern(const UnicodeString& skeleton,
                                      UCalendarDateFields field,
                                      UnicodeString& result,
                                      UErrorCode& status) const;

    /**
     * Get the fallback interval pattern.
     * @param  result   output param to receive the pattern
     * @return a reference to 'result'
     * @stable ICU 4.0
     */
    UnicodeString& getFallbackIntervalPattern(UnicodeString& result) const;


    /**
     * Re-set the fallback interval pattern.
     *
     * In construction, default fallback pattern is set as "{0} - {1}".
     * And constructor taking locale as parameter will set the
     * fallback pattern as what defined in the locale resource file.
     *
     * This method provides a way for user to replace the fallback pattern.
     *
     * @param fallbackPattern  fall-back interval pattern.
     * @param status           output param set to success/failure code on exit
     * @stable ICU 4.0
     */
    void setFallbackIntervalPattern(const UnicodeString& fallbackPattern,
                                    UErrorCode& status);


    /** Get default order -- whether the first date in pattern is later date
                             or not.
     * return default date ordering in interval pattern. true if the first date
     *        in pattern is later date, false otherwise.
     * @stable ICU 4.0
     */
    UBool getDefaultOrder() const;


    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 4.0
     */
    virtual UClassID getDynamicClassID() const override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 4.0
     */
    static UClassID U_EXPORT2 getStaticClassID();


private:
    /**
     * DateIntervalFormat will need access to
     * getBestSkeleton(), parseSkeleton(), enum IntervalPatternIndex,
     * and calendarFieldToPatternIndex().
     *
     * Instead of making above public,
     * make DateIntervalFormat a friend of DateIntervalInfo.
     */
    friend class DateIntervalFormat;

    /**
     * Internal struct used to load resource bundle data.
     */
    struct U_HIDDEN DateIntervalSink;

    /**
     * Following is for saving the interval patterns.
     * We only support interval patterns on
     * ERA, YEAR, MONTH, DAY, AM_PM, HOUR, MINUTE, SECOND and MILLISECOND.
     */
    enum IntervalPatternIndex
    {
        kIPI_ERA,
        kIPI_YEAR,
        kIPI_MONTH,
        kIPI_DATE,
        kIPI_AM_PM,
        kIPI_HOUR,
        kIPI_MINUTE,
        kIPI_SECOND,
        kIPI_MILLISECOND,
        kIPI_MAX_INDEX
    };
public:
#ifndef U_HIDE_INTERNAL_API
    /**
     * Max index for stored interval patterns
     * @internal ICU 4.4
     */
     enum {
         kMaxIntervalPatternIndex = kIPI_MAX_INDEX
     };
#endif  /* U_HIDE_INTERNAL_API */
private:


    /**
     * Initialize the DateIntervalInfo from locale
     * @param locale   the given locale.
     * @param status   output param set to success/failure code on exit
     */
    void initializeData(const Locale& locale, UErrorCode& status);


    /* Set Interval pattern.
     *
     * It sets interval pattern into the hash map.
     *
     * @param skeleton         skeleton on which the interval pattern based
     * @param lrgDiffCalUnit   the largest different calendar unit.
     * @param intervalPattern  the interval pattern on the largest different
     *                         calendar unit.
     * @param status           output param set to success/failure code on exit
     */
    void setIntervalPatternInternally(const UnicodeString& skeleton,
                                      UCalendarDateFields lrgDiffCalUnit,
                                      const UnicodeString& intervalPattern,
                                      UErrorCode& status);


    /**given an input skeleton, get the best match skeleton
     * which has pre-defined interval pattern in resource file.
     * Also return the difference between the input skeleton
     * and the best match skeleton.
     *
     * TODO (xji): set field weight or
     *             isolate the functionality in DateTimePatternGenerator
     * @param  skeleton               input skeleton
     * @param  bestMatchDistanceInfo  the difference between input skeleton
     *                                and best match skeleton.
     *         0, if there is exact match for input skeleton
     *         1, if there is only field width difference between
     *            the best match and the input skeleton
     *         2, the only field difference is 'v' and 'z'
     *        -1, if there is calendar field difference between
     *            the best match and the input skeleton
     * @return                        best match skeleton
     */
    const UnicodeString* getBestSkeleton(const UnicodeString& skeleton,
                                         int8_t& bestMatchDistanceInfo) const;


    /**
     * Parse skeleton, save each field's width.
     * It is used for looking for best match skeleton,
     * and adjust pattern field width.
     * @param skeleton            skeleton to be parsed
     * @param skeletonFieldWidth  parsed skeleton field width
     */
    static void U_EXPORT2 parseSkeleton(const UnicodeString& skeleton,
                                        int32_t* skeletonFieldWidth);


    /**
     * Check whether one field width is numeric while the other is string.
     *
     * TODO (xji): make it general
     *
     * @param fieldWidth          one field width
     * @param anotherFieldWidth   another field width
     * @param patternLetter       pattern letter char
     * @return true if one field width is numeric and the other is string,
     *         false otherwise.
     */
    static UBool U_EXPORT2 stringNumeric(int32_t fieldWidth,
                                         int32_t anotherFieldWidth,
                                         char patternLetter);


    /**
     * Convert calendar field to the interval pattern index in
     * hash table.
     *
     * Since we only support the following calendar fields:
     * ERA, YEAR, MONTH, DATE, DAY_OF_MONTH, DAY_OF_WEEK,
     * AM_PM, HOUR, HOUR_OF_DAY, MINUTE, SECOND, and MILLISECOND.
     * We reserve only 4 interval patterns for a skeleton.
     *
     * @param field    calendar field
     * @param status   output param set to success/failure code on exit
     * @return  interval pattern index in hash table
     */
    static IntervalPatternIndex U_EXPORT2 calendarFieldToIntervalIndex(
                                                      UCalendarDateFields field,
                                                      UErrorCode& status);


    /**
     * delete hash table (of type fIntervalPatterns).
     *
     * @param hTable  hash table to be deleted
     */
    void deleteHash(Hashtable* hTable);


    /**
     * initialize hash table (of type fIntervalPatterns).
     *
     * @param status   output param set to success/failure code on exit
     * @return         hash table initialized
     */
    Hashtable* initHash(UErrorCode& status);



    /**
     * copy hash table (of type fIntervalPatterns).
     *
     * @param source   the source to copy from
     * @param target   the target to copy to
     * @param status   output param set to success/failure code on exit
     */
    void copyHash(const Hashtable* source, Hashtable* target, UErrorCode& status);


    // data members
    // fallback interval pattern
    UnicodeString fFallbackIntervalPattern;
    // default order
    UBool fFirstDateInPtnIsLaterDate;

    // HashMap<UnicodeString, UnicodeString[kIPI_MAX_INDEX]>
    // HashMap( skeleton, pattern[largest_different_field] )
    Hashtable* fIntervalPatterns;

};// end class DateIntervalInfo


inline bool
DateIntervalInfo::operator!=(const DateIntervalInfo& other) const {
    return !operator==(other);
}


U_NAMESPACE_END

#endif

#endif /* U_SHOW_CPLUSPLUS_API */

#endif

