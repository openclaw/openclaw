// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*************************************************************************
* Copyright (c) 1997-2016, International Business Machines Corporation
* and others. All Rights Reserved.
**************************************************************************
*
* File TIMEZONE.H
*
* Modification History:
*
*   Date        Name        Description
*   04/21/97    aliu        Overhauled header.
*   07/09/97    helena      Changed createInstance to createDefault.
*   08/06/97    aliu        Removed dependency on internal header for Hashtable.
*   08/10/98    stephen        Changed getDisplayName() API conventions to match
*   08/19/98    stephen        Changed createTimeZone() to never return 0
*   09/02/98    stephen        Sync to JDK 1.2 8/31
*                            - Added getOffset(... monthlen ...)
*                            - Added hasSameRules()
*   09/15/98    stephen        Added getStaticClassID
*   12/03/99    aliu        Moved data out of static table into icudata.dll.
*                           Hashtable replaced by new static data structures.
*   12/14/99    aliu        Made GMT public.
*   08/15/01    grhoten     Made GMT private and added the getGMT() function
**************************************************************************
*/

#ifndef TIMEZONE_H
#define TIMEZONE_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file 
 * \brief C++ API: TimeZone object
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/uobject.h"
#include "unicode/unistr.h"
#include "unicode/ures.h"
#include "unicode/ucal.h"

U_NAMESPACE_BEGIN

class StringEnumeration;

/**
 *
 * <code>TimeZone</code> represents a time zone offset, and also figures out daylight
 * savings.
 *
 * <p>
 * Typically, you get a <code>TimeZone</code> using <code>createDefault</code>
 * which creates a <code>TimeZone</code> based on the time zone where the program
 * is running. For example, for a program running in Japan, <code>createDefault</code>
 * creates a <code>TimeZone</code> object based on Japanese Standard Time.
 *
 * <p>
 * You can also get a <code>TimeZone</code> using <code>createTimeZone</code> along
 * with a time zone ID. For instance, the time zone ID for the US Pacific
 * Time zone is "America/Los_Angeles". So, you can get a Pacific Time <code>TimeZone</code> object
 * with:
 * \htmlonly<blockquote>\endhtmlonly
 * <pre>
 * TimeZone *tz = TimeZone::createTimeZone("America/Los_Angeles");
 * </pre>
 * \htmlonly</blockquote>\endhtmlonly
 * You can use the <code>createEnumeration</code> method to iterate through
 * all the supported time zone IDs, or the <code>getCanonicalID</code> method to check
 * if a time zone ID is supported or not.  You can then choose a
 * supported ID to get a <code>TimeZone</code>.
 * If the time zone you want is not represented by one of the
 * supported IDs, then you can create a custom time zone ID with
 * the following syntax:
 *
 * \htmlonly<blockquote>\endhtmlonly
 * <pre>
 * GMT[+|-]hh[[:]mm]
 * </pre>
 * \htmlonly</blockquote>\endhtmlonly
 *
 * For example, you might specify GMT+14:00 as a custom
 * time zone ID.  The <code>TimeZone</code> that is returned
 * when you specify a custom time zone ID uses the specified
 * offset from GMT(=UTC) and does not observe daylight saving
 * time. For example, you might specify GMT+14:00 as a custom
 * time zone ID to create a TimeZone representing 14 hours ahead
 * of GMT (with no daylight saving time). In addition,
 * <code>getCanonicalID</code> can also be used to
 * normalize a custom time zone ID.
 *
 * TimeZone is an abstract class representing a time zone.  A TimeZone is needed for
 * Calendar to produce local time for a particular time zone.  A TimeZone comprises
 * three basic pieces of information:
 * <ul>
 *    <li>A time zone offset; that, is the number of milliseconds to add or subtract
 *      from a time expressed in terms of GMT to convert it to the same time in that
 *      time zone (without taking daylight savings time into account).</li>
 *    <li>Logic necessary to take daylight savings time into account if daylight savings
 *      time is observed in that time zone (e.g., the days and hours on which daylight
 *      savings time begins and ends).</li>
 *    <li>An ID.  This is a text string that uniquely identifies the time zone.</li>
 * </ul>
 *
 * (Only the ID is actually implemented in TimeZone; subclasses of TimeZone may handle
 * daylight savings time and GMT offset in different ways.  Currently we have the following
 * TimeZone subclasses: RuleBasedTimeZone, SimpleTimeZone, and VTimeZone.)
 * <P>
 * The TimeZone class contains a static list containing a TimeZone object for every
 * combination of GMT offset and daylight-savings time rules currently in use in the
 * world, each with a unique ID.  Each ID consists of a region (usually a continent or
 * ocean) and a city in that region, separated by a slash, (for example, US Pacific
 * Time is "America/Los_Angeles.")  Because older versions of this class used
 * three- or four-letter abbreviations instead, there is also a table that maps the older
 * abbreviations to the newer ones (for example, "PST" maps to "America/Los_Angeles").
 * Anywhere the API requires an ID, you can use either form.
 * <P>
 * To create a new TimeZone, you call the factory function TimeZone::createTimeZone()
 * and pass it a time zone ID.  You can use the createEnumeration() function to
 * obtain a list of all the time zone IDs recognized by createTimeZone().
 * <P>
 * You can also use TimeZone::createDefault() to create a TimeZone.  This function uses
 * platform-specific APIs to produce a TimeZone for the time zone corresponding to
 * the client's computer's physical location.  For example, if you're in Japan (assuming
 * your machine is set up correctly), TimeZone::createDefault() will return a TimeZone
 * for Japanese Standard Time ("Asia/Tokyo").
 */
class U_I18N_API TimeZone : public UObject {
public:
    /**
     * @stable ICU 2.0
     */
    virtual ~TimeZone();

    /**
     * Returns the "unknown" time zone.
     * It behaves like the GMT/UTC time zone but has the
     * <code>UCAL_UNKNOWN_ZONE_ID</code> = "Etc/Unknown".
     * createTimeZone() returns a mutable clone of this time zone if the input ID is not recognized.
     *
     * @return the "unknown" time zone.
     * @see UCAL_UNKNOWN_ZONE_ID
     * @see createTimeZone
     * @see getGMT
     * @stable ICU 49
     */
    static const TimeZone& U_EXPORT2 getUnknown();

    /**
     * The GMT (=UTC) time zone has a raw offset of zero and does not use daylight
     * savings time. This is a commonly used time zone.
     *
     * <p>Note: For backward compatibility reason, the ID used by the time
     * zone returned by this method is "GMT", although the ICU's canonical
     * ID for the GMT time zone is "Etc/GMT".
     *
     * @return the GMT/UTC time zone.
     * @see getUnknown
     * @stable ICU 2.0
     */
    static const TimeZone* U_EXPORT2 getGMT();

    /**
     * Creates a <code>TimeZone</code> for the given ID.
     * @param ID the ID for a <code>TimeZone</code>, such as "America/Los_Angeles",
     * or a custom ID such as "GMT-8:00".
     * @return the specified <code>TimeZone</code>, or a mutable clone of getUnknown()
     * if the given ID cannot be understood or if the given ID is "Etc/Unknown".
     * The return result is guaranteed to be non-nullptr.
     * If you require that the specific zone asked for be returned,
     * compare the result with getUnknown() or check the ID of the return result.
     * @stable ICU 2.0
     */
    static TimeZone* U_EXPORT2 createTimeZone(const UnicodeString& ID);

    /**
     * Returns an enumeration over system time zone IDs with the given
     * filter conditions.
     * @param zoneType      The system time zone type.
     * @param region        The ISO 3166 two-letter country code or UN M.49
     *                      three-digit area code. When nullptr, no filtering
     *                      done by region. 
     * @param rawOffset     An offset from GMT in milliseconds, ignoring
     *                      the effect of daylight savings time, if any.
     *                      When nullptr, no filtering done by zone offset.
     * @param ec            Output param to filled in with a success or
     *                      an error.
     * @return an enumeration object, owned by the caller.
     * @stable ICU 4.8
     */
    static StringEnumeration* U_EXPORT2 createTimeZoneIDEnumeration(
        USystemTimeZoneType zoneType,
        const char* region,
        const int32_t* rawOffset,
        UErrorCode& ec);

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Returns an enumeration over all recognized time zone IDs. (i.e.,
     * all strings that createTimeZone() accepts)
     *
     * @return an enumeration object, owned by the caller.
     * @deprecated ICU 70 Use createEnumeration(UErrorCode&) instead.
     */
    static StringEnumeration* U_EXPORT2 createEnumeration();
#endif  // U_HIDE_DEPRECATED_API

    /**
     * Returns an enumeration over all recognized time zone IDs. (i.e.,
     * all strings that createTimeZone() accepts)
     *
     * @param status Receives the status.
     * @return an enumeration object, owned by the caller.
     * @stable ICU 70
     */
    static StringEnumeration* U_EXPORT2 createEnumeration(UErrorCode& status);

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Returns an enumeration over time zone IDs with a given raw
     * offset from GMT.  There may be several times zones with the
     * same GMT offset that differ in the way they handle daylight
     * savings time.  For example, the state of Arizona doesn't
     * observe daylight savings time.  If you ask for the time zone
     * IDs corresponding to GMT-7:00, you'll get back an enumeration
     * over two time zone IDs: "America/Denver," which corresponds to
     * Mountain Standard Time in the winter and Mountain Daylight Time
     * in the summer, and "America/Phoenix", which corresponds to
     * Mountain Standard Time year-round, even in the summer.
     *
     * @param rawOffset an offset from GMT in milliseconds, ignoring
     * the effect of daylight savings time, if any
     * @return an enumeration object, owned by the caller
     * @deprecated ICU 70 Use createEnumerationForRawOffset(int32_t,UErrorCode&) instead.
     */
    static StringEnumeration* U_EXPORT2 createEnumeration(int32_t rawOffset);
#endif  // U_HIDE_DEPRECATED_API

    /**
     * Returns an enumeration over time zone IDs with a given raw
     * offset from GMT.  There may be several times zones with the
     * same GMT offset that differ in the way they handle daylight
     * savings time.  For example, the state of Arizona doesn't
     * observe daylight savings time.  If you ask for the time zone
     * IDs corresponding to GMT-7:00, you'll get back an enumeration
     * over two time zone IDs: "America/Denver," which corresponds to
     * Mountain Standard Time in the winter and Mountain Daylight Time
     * in the summer, and "America/Phoenix", which corresponds to
     * Mountain Standard Time year-round, even in the summer.
     *
     * @param rawOffset an offset from GMT in milliseconds, ignoring
     * the effect of daylight savings time, if any
     * @param status Receives the status.
     * @return an enumeration object, owned by the caller
     * @stable ICU 70
     */
    static StringEnumeration* U_EXPORT2 createEnumerationForRawOffset(int32_t rawOffset, UErrorCode& status);

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Returns an enumeration over time zone IDs associated with the
     * given region.  Some zones are affiliated with no region
     * (e.g., "UTC"); these may also be retrieved, as a group.
     *
     * @param region The ISO 3166 two-letter country code, or nullptr to
     * retrieve zones not affiliated with any region.
     * @return an enumeration object, owned by the caller
     * @deprecated ICU 70 Use createEnumerationForRegion(const char*,UErrorCode&) instead.
     */
    static StringEnumeration* U_EXPORT2 createEnumeration(const char* region);
#endif  // U_HIDE_DEPRECATED_API

    /**
     * Returns an enumeration over time zone IDs associated with the
     * given region.  Some zones are affiliated with no region
     * (e.g., "UTC"); these may also be retrieved, as a group.
     *
     * @param region The ISO 3166 two-letter country code, or nullptr to
     * retrieve zones not affiliated with any region.
     * @param status Receives the status.
     * @return an enumeration object, owned by the caller
     * @stable ICU 70
     */
    static StringEnumeration* U_EXPORT2 createEnumerationForRegion(const char* region, UErrorCode& status);

    /**
     * Returns the number of IDs in the equivalency group that
     * includes the given ID.  An equivalency group contains zones
     * that have the same GMT offset and rules.
     *
     * <p>The returned count includes the given ID; it is always >= 1.
     * The given ID must be a system time zone.  If it is not, returns
     * zero.
     * @param id a system time zone ID
     * @return the number of zones in the equivalency group containing
     * 'id', or zero if 'id' is not a valid system ID
     * @see #getEquivalentID
     * @stable ICU 2.0
     */
    static int32_t U_EXPORT2 countEquivalentIDs(const UnicodeString& id);

    /**
     * Returns an ID in the equivalency group that
     * includes the given ID.  An equivalency group contains zones
     * that have the same GMT offset and rules.
     *
     * <p>The given index must be in the range 0..n-1, where n is the
     * value returned by <code>countEquivalentIDs(id)</code>.  For
     * some value of 'index', the returned value will be equal to the
     * given id.  If the given id is not a valid system time zone, or
     * if 'index' is out of range, then returns an empty string.
     * @param id a system time zone ID
     * @param index a value from 0 to n-1, where n is the value
     * returned by <code>countEquivalentIDs(id)</code>
     * @return the ID of the index-th zone in the equivalency group
     * containing 'id', or an empty string if 'id' is not a valid
     * system ID or 'index' is out of range
     * @see #countEquivalentIDs
     * @stable ICU 2.0
     */
    static UnicodeString U_EXPORT2 getEquivalentID(const UnicodeString& id,
                                               int32_t index);

    /**
     * Creates an instance of TimeZone detected from the current host
     * system configuration. If the host system detection routines fail,
     * or if they specify a TimeZone or TimeZone offset which is not
     * recognized, then the special TimeZone "Etc/Unknown" is returned.
     * 
     * Note that ICU4C does not change the default time zone unless
     * `TimeZone::adoptDefault(TimeZone*)` or 
     * `TimeZone::setDefault(const TimeZone&)` is explicitly called by a
     * user. This method does not update the current ICU's default,
     * and may return a different TimeZone from the one returned by
     * `TimeZone::createDefault()`.
     *
     * <p>This function is not thread safe.</p>
     *
     * @return  A new instance of TimeZone detected from the current host system
     *          configuration.
     * @see adoptDefault
     * @see setDefault
     * @see createDefault
     * @see getUnknown
     * @stable ICU 55
     */
    static TimeZone* U_EXPORT2 detectHostTimeZone();

    /**
     * Creates a new copy of the default TimeZone for this host. Unless the default time
     * zone has already been set using adoptDefault() or setDefault(), the default is
     * determined by querying the host system configuration. If the host system detection
     * routines fail, or if they specify a TimeZone or TimeZone offset which is not
     * recognized, then the special TimeZone "Etc/Unknown" is instantiated and made the
     * default.
     *
     * @return   A default TimeZone. Clients are responsible for deleting the time zone
     *           object returned.
     * @see getUnknown
     * @stable ICU 2.0
     */
    static TimeZone* U_EXPORT2 createDefault();

#ifndef U_HIDE_INTERNAL_API
    /**
     * If the locale contains the timezone keyword, creates a copy of that TimeZone.
     * Otherwise, create the default timezone.
     *
     * @param locale a locale which may contains 'timezone' keyword/value.
     * @return   A TimeZone. Clients are responsible for deleting the time zone
     *           object returned.
     * @internal
     */
    static TimeZone* U_EXPORT2 forLocaleOrDefault(const Locale& locale);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Sets the default time zone (i.e., what's returned by createDefault()) to be the
     * specified time zone.  If nullptr is specified for the time zone, the default time
     * zone is set to the default host time zone.  This call adopts the TimeZone object
     * passed in; the client is no longer responsible for deleting it.
     *
     * @param zone  A pointer to the new TimeZone object to use as the default.
     * @stable ICU 2.0
     */
    static void U_EXPORT2 adoptDefault(TimeZone* zone);

#ifndef U_HIDE_SYSTEM_API
    /**
     * Same as adoptDefault(), except that the TimeZone object passed in is NOT adopted;
     * the caller remains responsible for deleting it.
     *
     * @param zone  The given timezone.
     * @system
     * @stable ICU 2.0
     */
    static void U_EXPORT2 setDefault(const TimeZone& zone);
#endif  /* U_HIDE_SYSTEM_API */

    /**
     * Returns the timezone data version currently used by ICU.
     * @param status Output param to filled in with a success or an error.
     * @return the version string, such as "2007f"
     * @stable ICU 3.8
     */
    static const char* U_EXPORT2 getTZDataVersion(UErrorCode& status);

    /**
     * Returns the canonical system timezone ID or the normalized
     * custom time zone ID for the given time zone ID.
     * @param id            The input time zone ID to be canonicalized.
     * @param canonicalID   Receives the canonical system time zone ID
     *                      or the custom time zone ID in normalized format.
     * @param status        Receives the status.  When the given time zone ID
     *                      is neither a known system time zone ID nor a
     *                      valid custom time zone ID, U_ILLEGAL_ARGUMENT_ERROR
     *                      is set.
     * @return A reference to the result.
     * @stable ICU 4.0
     */
    static UnicodeString& U_EXPORT2 getCanonicalID(const UnicodeString& id,
        UnicodeString& canonicalID, UErrorCode& status);

    /**
     * Returns the canonical system time zone ID or the normalized
     * custom time zone ID for the given time zone ID.
     * @param id            The input time zone ID to be canonicalized.
     * @param canonicalID   Receives the canonical system time zone ID
     *                      or the custom time zone ID in normalized format.
     * @param isSystemID    Receives if the given ID is a known system
     *                      time zone ID.
     * @param status        Receives the status.  When the given time zone ID
     *                      is neither a known system time zone ID nor a
     *                      valid custom time zone ID, U_ILLEGAL_ARGUMENT_ERROR
     *                      is set.
     * @return A reference to the result.
     * @stable ICU 4.0
     */
    static UnicodeString& U_EXPORT2 getCanonicalID(const UnicodeString& id,
        UnicodeString& canonicalID, UBool& isSystemID, UErrorCode& status);


    /**
     * Returns the preferred time zone ID in the IANA time zone database for the given time zone ID.
     * There are two types of preferred IDs. The first type is the one defined in zone.tab file,
     * such as "America/Los_Angeles". The second types is the one defined for zones not associated
     * with a specific region, but not defined with "Link" syntax such as "Etc/GMT+10".
     *
     * <p>Note: For most of valid time zone IDs, this method returns an ID same as getCanonicalID().
     * getCanonicalID() is based on canonical time zone IDs defined in Unicode CLDR.
     * These canonical time zone IDs in CLDR were based on very old version of the time zone database.
     * In the IANA time zone database, some IDs were updated since then. This API returns a newer
     * time zone ID. For example, CLDR defines "Asia/Calcutta" as the canonical time zone ID. This
     * method returns "Asia/Kolkata" instead.
     * <p> "Etc/Unknown" is a special time zone ID defined by CLDR. There are no corresponding zones
     * in the IANA time zone database. Therefore, this API returns U_ILLEGAL_ARGUMENT_ERROR when the
     * input ID is "Etc/Unknown".
     *
     * @param id        The input time zone ID.
     * @param ianaID    Receives the preferred time zone ID in the IANA time zone database. When
     *                  the given time zone ID is not a known time zone ID, this method sets an
     *                  invalid (bogus) string.
     * @param status    Receives the status.  When the given time zone ID is not a known time zone
     *                  ID, U_ILLEGAL_ARGUMENT_ERROR is set.
     * @return  A reference to the result.
     * @stable ICU 74
     */
    static UnicodeString& U_EXPORT2 getIanaID(const UnicodeString&id, UnicodeString& ianaID,
        UErrorCode& status);

    /**
    * Converts a system time zone ID to an equivalent Windows time zone ID. For example,
    * Windows time zone ID "Pacific Standard Time" is returned for input "America/Los_Angeles".
    *
    * <p>There are system time zones that cannot be mapped to Windows zones. When the input
    * system time zone ID is unknown or unmappable to a Windows time zone, then the result will be
    * empty, but the operation itself remains successful (no error status set on return).
    *
    * <p>This implementation utilizes <a href="http://unicode.org/cldr/charts/supplemental/zone_tzid.html">
    * Zone-Tzid mapping data</a>. The mapping data is updated time to time. To get the latest changes,
    * please read the ICU user guide section <a href="https://unicode-org.github.io/icu/userguide/datetime/timezone#updating-the-time-zone-data">
    * Updating the Time Zone Data</a>.
    *
    * @param id        A system time zone ID.
    * @param winid     Receives a Windows time zone ID. When the input system time zone ID is unknown
    *                  or unmappable to a Windows time zone ID, then an empty string is set on return.
    * @param status    Receives the status.
    * @return          A reference to the result (<code>winid</code>).
    * @see getIDForWindowsID
    *
    * @stable ICU 52
    */
    static UnicodeString& U_EXPORT2 getWindowsID(const UnicodeString& id,
        UnicodeString& winid, UErrorCode& status);

    /**
    * Converts a Windows time zone ID to an equivalent system time zone ID
    * for a region. For example, system time zone ID "America/Los_Angeles" is returned
    * for input Windows ID "Pacific Standard Time" and region "US" (or <code>null</code>),
    * "America/Vancouver" is returned for the same Windows ID "Pacific Standard Time" and
    * region "CA".
    *
    * <p>Not all Windows time zones can be mapped to system time zones. When the input
    * Windows time zone ID is unknown or unmappable to a system time zone, then the result
    * will be empty, but the operation itself remains successful (no error status set on return).
    *
    * <p>This implementation utilizes <a href="http://unicode.org/cldr/charts/supplemental/zone_tzid.html">
    * Zone-Tzid mapping data</a>. The mapping data is updated time to time. To get the latest changes,
    * please read the ICU user guide section <a href="https://unicode-org.github.io/icu/userguide/datetime/timezone#updating-the-time-zone-data">
    * Updating the Time Zone Data</a>.
    *
    * @param winid     A Windows time zone ID.
    * @param region    A NUL-terminated region code, or <code>nullptr</code> if no regional preference.
    * @param id        Receives a system time zone ID. When the input Windows time zone ID is unknown
    *                  or unmappable to a system time zone ID, then an empty string is set on return.
    * @param status    Receives the status.
    * @return          A reference to the result (<code>id</code>).
    * @see getWindowsID
    *
    * @stable ICU 52
    */
    static UnicodeString& U_EXPORT2 getIDForWindowsID(const UnicodeString& winid, const char* region,
        UnicodeString& id, UErrorCode& status);

    /**
     * Returns true if the two TimeZones are equal.  (The TimeZone version only compares
     * IDs, but subclasses are expected to also compare the fields they add.)
     *
     * @param that  The TimeZone object to be compared with.
     * @return      true if the given TimeZone is equal to this TimeZone; false
     *              otherwise.
     * @stable ICU 2.0
     */
    virtual bool operator==(const TimeZone& that) const;

    /**
     * Returns true if the two TimeZones are NOT equal; that is, if operator==() returns
     * false.
     *
     * @param that  The TimeZone object to be compared with.
     * @return      true if the given TimeZone is not equal to this TimeZone; false
     *              otherwise.
     * @stable ICU 2.0
     */
    bool operator!=(const TimeZone& that) const {return !operator==(that);}

    /**
     * Returns the TimeZone's adjusted GMT offset (i.e., the number of milliseconds to add
     * to GMT to get local time in this time zone, taking daylight savings time into
     * account) as of a particular reference date.  The reference date is used to determine
     * whether daylight savings time is in effect and needs to be figured into the offset
     * that is returned (in other words, what is the adjusted GMT offset in this time zone
     * at this particular date and time?).  For the time zones produced by createTimeZone(),
     * the reference data is specified according to the Gregorian calendar, and the date
     * and time fields are local standard time.
     *
     * <p>Note: Don't call this method. Instead, call the getOffset(UDate...) overload,
     * which returns both the raw and the DST offset for a given time. This method
     * is retained only for backward compatibility.
     *
     * @param era        The reference date's era
     * @param year       The reference date's year
     * @param month      The reference date's month (0-based; 0 is January)
     * @param day        The reference date's day-in-month (1-based)
     * @param dayOfWeek  The reference date's day-of-week (1-based; 1 is Sunday)
     * @param millis     The reference date's milliseconds in day, local standard time
     * @param status     Output param to filled in with a success or an error.
     * @return           The offset in milliseconds to add to GMT to get local time.
     * @stable ICU 2.0
     */
    virtual int32_t getOffset(uint8_t era, int32_t year, int32_t month, int32_t day,
                              uint8_t dayOfWeek, int32_t millis, UErrorCode& status) const = 0;

    /**
     * Gets the time zone offset, for current date, modified in case of
     * daylight savings. This is the offset to add *to* UTC to get local time.
     *
     * <p>Note: Don't call this method. Instead, call the getOffset(UDate...) overload,
     * which returns both the raw and the DST offset for a given time. This method
     * is retained only for backward compatibility.
     *
     * @param era the era of the given date.
     * @param year the year in the given date.
     * @param month the month in the given date.
     * Month is 0-based. e.g., 0 for January.
     * @param day the day-in-month of the given date.
     * @param dayOfWeek the day-of-week of the given date.
     * @param milliseconds the millis in day in <em>standard</em> local time.
     * @param monthLength the length of the given month in days.
     * @param status     Output param to filled in with a success or an error.
     * @return the offset to add *to* GMT to get local time.
     * @stable ICU 2.0
     */
    virtual int32_t getOffset(uint8_t era, int32_t year, int32_t month, int32_t day,
                           uint8_t dayOfWeek, int32_t milliseconds,
                           int32_t monthLength, UErrorCode& status) const = 0;

    /**
     * Returns the time zone raw and GMT offset for the given moment
     * in time.  Upon return, local-millis = GMT-millis + rawOffset +
     * dstOffset.  All computations are performed in the proleptic
     * Gregorian calendar.  The default implementation in the TimeZone
     * class delegates to the 8-argument getOffset().
     *
     * @param date moment in time for which to return offsets, in
     * units of milliseconds from January 1, 1970 0:00 GMT, either GMT
     * time or local wall time, depending on `local'.
     * @param local if true, `date' is local wall time; otherwise it
     * is in GMT time.
     * @param rawOffset output parameter to receive the raw offset, that
     * is, the offset not including DST adjustments
     * @param dstOffset output parameter to receive the DST offset,
     * that is, the offset to be added to `rawOffset' to obtain the
     * total offset between local and GMT time. If DST is not in
     * effect, this value is zero; otherwise it is a positive value,
     * typically one hour.
     * @param ec input-output error code
     *
     * @stable ICU 2.8
     */
    virtual void getOffset(UDate date, UBool local, int32_t& rawOffset,
                           int32_t& dstOffset, UErrorCode& ec) const;

    /**
     * Sets the TimeZone's raw GMT offset (i.e., the number of milliseconds to add
     * to GMT to get local time, before taking daylight savings time into account).
     *
     * @param offsetMillis  The new raw GMT offset for this time zone.
     * @stable ICU 2.0
     */
    virtual void setRawOffset(int32_t offsetMillis) = 0;

    /**
     * Returns the TimeZone's raw GMT offset (i.e., the number of milliseconds to add
     * to GMT to get local time, before taking daylight savings time into account).
     *
     * @return   The TimeZone's raw GMT offset.
     * @stable ICU 2.0
     */
    virtual int32_t getRawOffset() const = 0;

    /**
     * Fills in "ID" with the TimeZone's ID.
     *
     * @param ID  Receives this TimeZone's ID.
     * @return    A reference to 'ID'
     * @stable ICU 2.0
     */
    UnicodeString& getID(UnicodeString& ID) const;

    /**
     * Sets the TimeZone's ID to the specified value.  This doesn't affect any other
     * fields (for example, if you say<
     * blockquote><pre>
     * .     TimeZone* foo = TimeZone::createTimeZone("America/New_York");
     * .     foo.setID("America/Los_Angeles");
     * </pre>\htmlonly</blockquote>\endhtmlonly
     * the time zone's GMT offset and daylight-savings rules don't change to those for
     * Los Angeles.  They're still those for New York.  Only the ID has changed.)
     *
     * @param ID  The new time zone ID.
     * @stable ICU 2.0
     */
    void setID(const UnicodeString& ID);

    /**
     * Enum for use with getDisplayName
     * @stable ICU 2.4
     */
    enum EDisplayType {
        /**
         * Selector for short display name
         * @stable ICU 2.4
         */
        SHORT = 1,
        /**
         * Selector for long display name
         * @stable ICU 2.4
         */
        LONG,
        /**
         * Selector for short generic display name
         * @stable ICU 4.4
         */
        SHORT_GENERIC,
        /**
         * Selector for long generic display name
         * @stable ICU 4.4
         */
        LONG_GENERIC,
        /**
         * Selector for short display name derived
         * from time zone offset
         * @stable ICU 4.4
         */
        SHORT_GMT,
        /**
         * Selector for long display name derived
         * from time zone offset
         * @stable ICU 4.4
         */
        LONG_GMT,
        /**
         * Selector for short display name derived
         * from the time zone's fallback name
         * @stable ICU 4.4
         */
        SHORT_COMMONLY_USED,
        /**
         * Selector for long display name derived
         * from the time zone's fallback name
         * @stable ICU 4.4
         */
        GENERIC_LOCATION
    };

    /**
     * Returns a name of this time zone suitable for presentation to the user
     * in the default locale.
     * This method returns the long name, not including daylight savings.
     * If the display name is not available for the locale,
     * then this method returns a string in the localized GMT offset format
     * such as <code>GMT[+-]HH:mm</code>.
     * @param result the human-readable name of this time zone in the default locale.
     * @return       A reference to 'result'.
     * @stable ICU 2.0
     */
    UnicodeString& getDisplayName(UnicodeString& result) const;

    /**
     * Returns a name of this time zone suitable for presentation to the user
     * in the specified locale.
     * This method returns the long name, not including daylight savings.
     * If the display name is not available for the locale,
     * then this method returns a string in the localized GMT offset format
     * such as <code>GMT[+-]HH:mm</code>.
     * @param locale the locale in which to supply the display name.
     * @param result the human-readable name of this time zone in the given locale
     *               or in the default locale if the given locale is not recognized.
     * @return       A reference to 'result'.
     * @stable ICU 2.0
     */
    UnicodeString& getDisplayName(const Locale& locale, UnicodeString& result) const;

    /**
     * Returns a name of this time zone suitable for presentation to the user
     * in the default locale.
     * If the display name is not available for the locale,
     * then this method returns a string in the localized GMT offset format
     * such as <code>GMT[+-]HH:mm</code>.
     * @param inDaylight if true, return the daylight savings name.
     * @param style
     * @param result the human-readable name of this time zone in the default locale.
     * @return       A reference to 'result'.
     * @stable ICU 2.0
     */
    UnicodeString& getDisplayName(UBool inDaylight, EDisplayType style, UnicodeString& result) const;

    /**
     * Returns a name of this time zone suitable for presentation to the user
     * in the specified locale.
     * If the display name is not available for the locale,
     * then this method returns a string in the localized GMT offset format
     * such as <code>GMT[+-]HH:mm</code>.
     * @param inDaylight if true, return the daylight savings name.
     * @param style
     * @param locale the locale in which to supply the display name.
     * @param result the human-readable name of this time zone in the given locale
     *               or in the default locale if the given locale is not recognized.
     * @return       A reference to 'result'.
     * @stable ICU 2.0
     */
    UnicodeString& getDisplayName(UBool inDaylight, EDisplayType style, const Locale& locale, UnicodeString& result) const;
    
    /**
     * Queries if this time zone uses daylight savings time.
     * @return true if this time zone uses daylight savings time,
     * false, otherwise.
     * <p><strong>Note:</strong>The default implementation of
     * ICU TimeZone uses the tz database, which supports historic
     * rule changes, for system time zones. With the implementation,
     * there are time zones that used daylight savings time in the
     * past, but no longer used currently. For example, Asia/Tokyo has
     * never used daylight savings time since 1951. Most clients would
     * expect that this method to return <code>false</code> for such case.
     * The default implementation of this method returns <code>true</code>
     * when the time zone uses daylight savings time in the current
     * (Gregorian) calendar year.
     * <p>In Java 7, <code>observesDaylightTime()</code> was added in
     * addition to <code>useDaylightTime()</code>. In Java, <code>useDaylightTime()</code>
     * only checks if daylight saving time is observed by the last known
     * rule. This specification might not be what most users would expect
     * if daylight saving time is currently observed, but not scheduled
     * in future. In this case, Java's <code>userDaylightTime()</code> returns
     * <code>false</code>. To resolve the issue, Java 7 added <code>observesDaylightTime()</code>,
     * which takes the current rule into account. The method <code>observesDaylightTime()</code>
     * was added in ICU4J for supporting API signature compatibility with JDK.
     * In general, ICU4C also provides JDK compatible methods, but the current
     * implementation <code>userDaylightTime()</code> serves the purpose
     * (takes the current rule into account), <code>observesDaylightTime()</code>
     * is not added in ICU4C. In addition to <code>useDaylightTime()</code>, ICU4C
     * <code>BasicTimeZone</code> class (Note that <code>TimeZone::createTimeZone(const UnicodeString &ID)</code>
     * always returns a <code>BasicTimeZone</code>) provides a series of methods allowing
     * historic and future time zone rule iteration, so you can check if daylight saving
     * time is observed or not within a given period.
     * 
     * @stable ICU 2.0
     */
    virtual UBool useDaylightTime() const = 0;

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Queries if the given date is in daylight savings time in
     * this time zone.
     * This method is wasteful since it creates a new GregorianCalendar and
     * deletes it each time it is called. This is a deprecated method
     * and provided only for Java compatibility.
     *
     * @param date the given UDate.
     * @param status Output param filled in with success/error code.
     * @return true if the given date is in daylight savings time,
     * false, otherwise.
     * @deprecated ICU 2.4. Use Calendar::inDaylightTime() instead.
     */
    virtual UBool inDaylightTime(UDate date, UErrorCode& status) const = 0;
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Returns true if this zone has the same rule and offset as another zone.
     * That is, if this zone differs only in ID, if at all.
     * @param other the <code>TimeZone</code> object to be compared with
     * @return true if the given zone is the same as this one,
     * with the possible exception of the ID
     * @stable ICU 2.0
     */
    virtual UBool hasSameRules(const TimeZone& other) const;

    /**
     * Clones TimeZone objects polymorphically. Clients are responsible for deleting
     * the TimeZone object cloned.
     *
     * @return   A new copy of this TimeZone object.
     * @stable ICU 2.0
     */
    virtual TimeZone* clone() const = 0;

    /**
     * Return the class ID for this class.  This is useful only for
     * comparing to a return value from getDynamicClassID().
     * @return The class ID for all objects of this class.
     * @stable ICU 2.0
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Returns a unique class ID POLYMORPHICALLY. This method is to
     * implement a simple version of RTTI, since not all C++ compilers support genuine
     * RTTI. Polymorphic operator==() and clone() methods call this method.
     * <P>
     * Concrete subclasses of TimeZone must use the UOBJECT_DEFINE_RTTI_IMPLEMENTATION
     *  macro from uobject.h in their implementation to provide correct RTTI information.
     * @return   The class ID for this object. All objects of a given class have the
     *           same class ID. Objects of other classes have different class IDs.
     * @stable ICU 2.0
     */
    virtual UClassID getDynamicClassID() const override = 0;

    /**
     * Returns the amount of time to be added to local standard time
     * to get local wall clock time.
     * <p>
     * The default implementation always returns 3600000 milliseconds
     * (i.e., one hour) if this time zone observes Daylight Saving
     * Time. Otherwise, 0 (zero) is returned.
     * <p>
     * If an underlying TimeZone implementation subclass supports
     * historical Daylight Saving Time changes, this method returns
     * the known latest daylight saving value.
     *
     * @return the amount of saving time in milliseconds
     * @stable ICU 3.6
     */
    virtual int32_t getDSTSavings() const;

    /**
     * Gets the region code associated with the given
     * system time zone ID. The region code is either ISO 3166
     * 2-letter country code or UN M.49 3-digit area code.
     * When the time zone is not associated with a specific location,
     * for example - "Etc/UTC", "EST5EDT", then this method returns
     * "001" (UN M.49 area code for World).
     * 
     * @param id            The system time zone ID.
     * @param region        Output buffer for receiving the region code.
     * @param capacity      The size of the output buffer.
     * @param status        Receives the status.  When the given time zone ID
     *                      is not a known system time zone ID,
     *                      U_ILLEGAL_ARGUMENT_ERROR is set.
     * @return The length of the output region code.
     * @stable ICU 4.8 
     */ 
    static int32_t U_EXPORT2 getRegion(const UnicodeString& id, 
        char *region, int32_t capacity, UErrorCode& status); 

protected:

    /**
     * Default constructor.  ID is initialized to the empty string.
     * @stable ICU 2.0
     */
    TimeZone();

    /**
     * Construct a TimeZone with a given ID.
     * @param id a system time zone ID
     * @stable ICU 2.0
     */
    TimeZone(const UnicodeString &id);

    /**
     * Copy constructor.
     * @param source the object to be copied.
     * @stable ICU 2.0
     */
    TimeZone(const TimeZone& source);

    /**
     * Default assignment operator.
     * @param right the object to be copied.
     * @stable ICU 2.0
     */
    TimeZone& operator=(const TimeZone& right);

#ifndef U_HIDE_INTERNAL_API
    /**
     * Utility function. For internally loading rule data.
     * @param top Top resource bundle for tz data
     * @param ruleid ID of rule to load
     * @param oldbundle Old bundle to reuse or nullptr
     * @param status Status parameter
     * @return either a new bundle or *oldbundle
     * @internal
     */
    static UResourceBundle* loadRule(const UResourceBundle* top, const UnicodeString& ruleid, UResourceBundle* oldbundle, UErrorCode&status);
#endif  /* U_HIDE_INTERNAL_API */

private:
    friend class ZoneMeta;


    static TimeZone*        createCustomTimeZone(const UnicodeString&); // Creates a time zone based on the string.

    /**
     * Finds the given ID in the Olson tzdata. If the given ID is found in the tzdata,
     * returns the pointer to the ID resource. This method is exposed through ZoneMeta class
     * for ICU internal implementation and useful for building hashtable using a time zone
     * ID as a key.
     * @param id zone id string
     * @return the pointer of the ID resource, or nullptr.
     */
    static const char16_t* findID(const UnicodeString& id);

    /**
     * Resolve a link in Olson tzdata.  When the given id is known and it's not a link,
     * the id itself is returned.  When the given id is known and it is a link, then
     * dereferenced zone id is returned.  When the given id is unknown, then it returns
     * nullptr.
     * @param id zone id string
     * @return the dereferenced zone or nullptr
     */
    static const char16_t* dereferOlsonLink(const UnicodeString& id);

    /**
     * Returns the region code associated with the given zone,
     * or nullptr if the zone is not known.
     * @param id zone id string
     * @return the region associated with the given zone
     */
    static const char16_t* getRegion(const UnicodeString& id);

  public:
#ifndef U_HIDE_INTERNAL_API
    /**
     * Returns the region code associated with the given zone,
     * or nullptr if the zone is not known.
     * @param id zone id string
     * @param status Status parameter
     * @return the region associated with the given zone
     * @internal
     */
    static const char16_t* getRegion(const UnicodeString& id, UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */

  private:
    /**
     * Parses the given custom time zone identifier
     * @param id id A string of the form GMT[+-]hh:mm, GMT[+-]hhmm, or
     * GMT[+-]hh.
     * @param sign Receives parsed sign, 1 for positive, -1 for negative.
     * @param hour Receives parsed hour field
     * @param minute Receives parsed minute field
     * @param second Receives parsed second field
     * @return Returns true when the given custom id is valid.
     */
    static UBool parseCustomID(const UnicodeString& id, int32_t& sign, int32_t& hour,
        int32_t& minute, int32_t& second);

    /**
     * Parse a custom time zone identifier and return the normalized
     * custom time zone identifier for the given custom id string.
     * @param id a string of the form GMT[+-]hh:mm, GMT[+-]hhmm, or
     * GMT[+-]hh.
     * @param normalized Receives the normalized custom ID
     * @param status Receives the status.  When the input ID string is invalid,
     * U_ILLEGAL_ARGUMENT_ERROR is set.
     * @return The normalized custom id string.
    */
    static UnicodeString& getCustomID(const UnicodeString& id, UnicodeString& normalized,
        UErrorCode& status);

    /**
     * Returns the normalized custom time zone ID for the given offset fields.
     * @param hour offset hours
     * @param min offset minutes
     * @param sec offset seconds
     * @param negative sign of the offset, true for negative offset.
     * @param id Receives the format result (normalized custom ID)
     * @return The reference to id
     */
    static UnicodeString& formatCustomID(int32_t hour, int32_t min, int32_t sec,
        UBool negative, UnicodeString& id);

    UnicodeString           fID;    // this time zone's ID

    friend class TZEnumeration;
};


// -------------------------------------

inline UnicodeString&
TimeZone::getID(UnicodeString& ID) const
{
    ID = fID;
    return ID;
}

// -------------------------------------

inline void
TimeZone::setID(const UnicodeString& ID)
{
    fID = ID;
}
U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif //_TIMEZONE
//eof
