// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2011-2016, International Business Machines Corporation and
* others. All Rights Reserved.
*******************************************************************************
*/
#ifndef __TZNAMES_H
#define __TZNAMES_H

/**
 * \file
 * \brief C++ API: TimeZoneNames
 */
#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/uloc.h"
#include "unicode/unistr.h"

U_CDECL_BEGIN

/**
 * Constants for time zone display name types.
 * @stable ICU 50
 */
typedef enum UTimeZoneNameType {
    /**
     * Unknown display name type.
     * @stable ICU 50
     */
    UTZNM_UNKNOWN           = 0x00,
    /**
     * Long display name, such as "Eastern Time".
     * @stable ICU 50
     */
    UTZNM_LONG_GENERIC      = 0x01,
    /**
     * Long display name for standard time, such as "Eastern Standard Time".
     * @stable ICU 50
     */
    UTZNM_LONG_STANDARD     = 0x02,
    /**
     * Long display name for daylight saving time, such as "Eastern Daylight Time".
     * @stable ICU 50
     */
    UTZNM_LONG_DAYLIGHT     = 0x04,
    /**
     * Short display name, such as "ET".
     * @stable ICU 50
     */
    UTZNM_SHORT_GENERIC     = 0x08,
    /**
     * Short display name for standard time, such as "EST".
     * @stable ICU 50
     */
    UTZNM_SHORT_STANDARD    = 0x10,
    /**
     * Short display name for daylight saving time, such as "EDT".
     * @stable ICU 50
     */
    UTZNM_SHORT_DAYLIGHT    = 0x20,
    /**
     * Exemplar location name, such as "Los Angeles".
     * @stable ICU 51
     */
    UTZNM_EXEMPLAR_LOCATION = 0x40
} UTimeZoneNameType;

U_CDECL_END

U_NAMESPACE_BEGIN

class UVector;
struct MatchInfo;

/**
 * <code>TimeZoneNames</code> is an abstract class representing the time zone display name data model defined
 * by <a href="http://www.unicode.org/reports/tr35/">UTS#35 Unicode Locale Data Markup Language (LDML)</a>.
 * The model defines meta zone, which is used for storing a set of display names. A meta zone can be shared
 * by multiple time zones. Also a time zone may have multiple meta zone historic mappings.
 * <p>
 * For example, people in the United States refer the zone used by the east part of North America as "Eastern Time".
 * The tz database contains multiple time zones "America/New_York", "America/Detroit", "America/Montreal" and some
 * others that belong to "Eastern Time". However, assigning different display names to these time zones does not make
 * much sense for most of people.
 * <p>
 * In <a href="http://cldr.unicode.org/">CLDR</a> (which uses LDML for representing locale data), the display name
 * "Eastern Time" is stored as long generic display name of a meta zone identified by the ID "America_Eastern".
 * Then, there is another table maintaining the historic mapping to meta zones for each time zone. The time zones in
 * the above example ("America/New_York", "America/Detroit"...) are mapped to the meta zone "America_Eastern".
 * <p>
 * Sometimes, a time zone is mapped to a different time zone in the past. For example, "America/Indiana/Knox"
 * had been moving "Eastern Time" and "Central Time" back and forth. Therefore, it is necessary that time zone
 * to meta zones mapping data are stored by date range.
 *
 * <p><b>Note:</b>
 * The methods in this class assume that time zone IDs are already canonicalized. For example, you may not get proper
 * result returned by a method with time zone ID "America/Indiana/Indianapolis", because it's not a canonical time zone
 * ID (the canonical time zone ID for the time zone is "America/Indianapolis". See
 * {@link TimeZone#getCanonicalID(const UnicodeString& id, UnicodeString& canonicalID, UErrorCode& status)} about ICU
 * canonical time zone IDs.
 *
 * <p>
 * In CLDR, most of time zone display names except location names are provided through meta zones. But a time zone may
 * have a specific name that is not shared with other time zones.
 *
 * For example, time zone "Europe/London" has English long name for standard time "Greenwich Mean Time", which is also
 * shared with other time zones. However, the long name for daylight saving time is "British Summer Time", which is only
 * used for "Europe/London".
 *
 * <p>
 * {@link #getTimeZoneDisplayName} is designed for accessing a name only used by a single time zone.
 * But is not necessarily mean that a subclass implementation use the same model with CLDR. A subclass implementation
 * may provide time zone names only through {@link #getTimeZoneDisplayName}, or only through {@link #getMetaZoneDisplayName},
 * or both.
 *
 * <p>
 * The default <code>TimeZoneNames</code> implementation returned by {@link #createInstance}
 * uses the locale data imported from CLDR. In CLDR, set of meta zone IDs and mappings between zone IDs and meta zone
 * IDs are shared by all locales. Therefore, the behavior of {@link #getAvailableMetaZoneIDs},
 * {@link #getMetaZoneID}, and {@link #getReferenceZoneID} won't be changed no matter
 * what locale is used for getting an instance of <code>TimeZoneNames</code>.
 *
 * @stable ICU 50
 */
class U_I18N_API TimeZoneNames : public UObject {
public:
    /**
     * Destructor.
     * @stable ICU 50
     */
    virtual ~TimeZoneNames();

    /**
     * Return true if the given TimeZoneNames objects are semantically equal.
     * @param other the object to be compared with.
     * @return Return true if the given Format objects are semantically equal.
     * @stable ICU 50
     */
    virtual bool operator==(const TimeZoneNames& other) const = 0;

    /**
     * Return true if the given TimeZoneNames objects are not semantically
     * equal.
     * @param other the object to be compared with.
     * @return Return true if the given Format objects are not semantically equal.
     * @stable ICU 50
     */
    bool operator!=(const TimeZoneNames& other) const { return !operator==(other); }

    /**
     * Clone this object polymorphically.  The caller is responsible
     * for deleting the result when done.
     * @return A copy of the object
     * @stable ICU 50
     */
    virtual TimeZoneNames* clone() const = 0;

    /**
     * Returns an instance of <code>TimeZoneNames</code> for the specified locale.
     *
     * @param locale The locale.
     * @param status Receives the status.
     * @return An instance of <code>TimeZoneNames</code>
     * @stable ICU 50
     */
    static TimeZoneNames* U_EXPORT2 createInstance(const Locale& locale, UErrorCode& status);

    /**
     * Returns an instance of <code>TimeZoneNames</code> containing only short specific
     * zone names (SHORT_STANDARD and SHORT_DAYLIGHT),
     * compatible with the IANA tz database's zone abbreviations (not localized).
     * <br>
     * Note: The input locale is used for resolving ambiguous names (e.g. "IST" is parsed
     * as Israel Standard Time for Israel, while it is parsed as India Standard Time for
     * all other regions). The zone names returned by this instance are not localized.
     * @stable ICU 54
     */
     static TimeZoneNames* U_EXPORT2 createTZDBInstance(const Locale& locale, UErrorCode& status);

    /**
     * Returns an enumeration of all available meta zone IDs.
     * @param status Receives the status.
     * @return an enumeration object, owned by the caller.
     * @stable ICU 50
     */
    virtual StringEnumeration* getAvailableMetaZoneIDs(UErrorCode& status) const = 0;

    /**
     * Returns an enumeration of all available meta zone IDs used by the given time zone.
     * @param tzID The canonical time zone ID.
     * @param status Receives the status.
     * @return an enumeration object, owned by the caller.
     * @stable ICU 50
     */
    virtual StringEnumeration* getAvailableMetaZoneIDs(const UnicodeString& tzID, UErrorCode& status) const = 0;

    /**
     * Returns the meta zone ID for the given canonical time zone ID at the given date.
     * @param tzID The canonical time zone ID.
     * @param date The date.
     * @param mzID Receives the meta zone ID for the given time zone ID at the given date. If the time zone does not have a
     *          corresponding meta zone at the given date or the implementation does not support meta zones, "bogus" state
     *          is set.
     * @return A reference to the result.
     * @stable ICU 50
     */
    virtual UnicodeString& getMetaZoneID(const UnicodeString& tzID, UDate date, UnicodeString& mzID) const = 0;

    /**
     * Returns the reference zone ID for the given meta zone ID for the region.
     *
     * Note: Each meta zone must have a reference zone associated with a special region "001" (world).
     * Some meta zones may have region specific reference zone IDs other than the special region
     * "001". When a meta zone does not have any region specific reference zone IDs, this method
     * return the reference zone ID for the special region "001" (world).
     *
     * @param mzID The meta zone ID.
     * @param region The region.
     * @param tzID Receives the reference zone ID ("golden zone" in the LDML specification) for the given time zone ID for the
     *          region. If the meta zone is unknown or the implementation does not support meta zones, "bogus" state
     *          is set.
     * @return A reference to the result.
     * @stable ICU 50
     */
    virtual UnicodeString& getReferenceZoneID(const UnicodeString& mzID, const char* region, UnicodeString& tzID) const = 0;

    /**
     * Returns the display name of the meta zone.
     * @param mzID The meta zone ID.
     * @param type The display name type. See {@link #UTimeZoneNameType}.
     * @param name Receives the display name of the meta zone. When this object does not have a localized display name for the given
     *         meta zone with the specified type or the implementation does not provide any display names associated
     *         with meta zones, "bogus" state is set.
     * @return A reference to the result.
     * @stable ICU 50
     */
    virtual UnicodeString& getMetaZoneDisplayName(const UnicodeString& mzID, UTimeZoneNameType type, UnicodeString& name) const = 0;

    /**
     * Returns the display name of the time zone. Unlike {@link #getDisplayName},
     * this method does not get a name from a meta zone used by the time zone.
     * @param tzID The canonical time zone ID.
     * @param type The display name type. See {@link #UTimeZoneNameType}.
     * @param name Receives the display name for the time zone. When this object does not have a localized display name for the given
     *         time zone with the specified type, "bogus" state is set.
     * @return A reference to the result.
     * @stable ICU 50
     */
    virtual UnicodeString& getTimeZoneDisplayName(const UnicodeString& tzID, UTimeZoneNameType type, UnicodeString& name) const = 0;

    /**
     * Returns the exemplar location name for the given time zone. When this object does not have a localized location
     * name, the default implementation may still returns a programmatically generated name with the logic described
     * below.
     * <ol>
     * <li>Check if the ID contains "/". If not, return null.
     * <li>Check if the ID does not start with "Etc/" or "SystemV/". If it does, return null.
     * <li>Extract a substring after the last occurrence of "/".
     * <li>Replace "_" with " ".
     * </ol>
     * For example, "New York" is returned for the time zone ID "America/New_York" when this object does not have the
     * localized location name.
     *
     * @param tzID The canonical time zone ID
     * @param name Receives the exemplar location name for the given time zone, or "bogus" state is set when a localized
     *          location name is not available and the fallback logic described above cannot extract location from the ID.
     * @return A reference to the result.
     * @stable ICU 50
     */
    virtual UnicodeString& getExemplarLocationName(const UnicodeString& tzID, UnicodeString& name) const;

    /**
     * Returns the display name of the time zone at the given date.
     * <p>
     * <b>Note:</b> This method calls the subclass's {@link #getTimeZoneDisplayName} first. When the
     * result is bogus, this method calls {@link #getMetaZoneID} to get the meta zone ID mapped from the
     * time zone, then calls {@link #getMetaZoneDisplayName}.
     *
     * @param tzID The canonical time zone ID.
     * @param type The display name type. See {@link #UTimeZoneNameType}.
     * @param date The date.
     * @param name Receives the display name for the time zone at the given date. When this object does not have a localized display
     *          name for the time zone with the specified type and date, "bogus" state is set.
     * @return A reference to the result.
     * @stable ICU 50
     */
    virtual UnicodeString& getDisplayName(const UnicodeString& tzID, UTimeZoneNameType type, UDate date, UnicodeString& name) const;

    /**
     * @internal ICU internal only, for specific users only until proposed publicly.
     */
    virtual void loadAllDisplayNames(UErrorCode& status);

    /**
     * @internal ICU internal only, for specific users only until proposed publicly.
     */
    virtual void getDisplayNames(const UnicodeString& tzID, const UTimeZoneNameType types[], int32_t numTypes, UDate date, UnicodeString dest[], UErrorCode& status) const;

    /**
     * <code>MatchInfoCollection</code> represents a collection of time zone name matches used by
     * {@link TimeZoneNames#find}.
     * @internal
     */
    class U_I18N_API MatchInfoCollection : public UMemory {
    public:
        /**
         * Constructor.
         * @internal
         */
        MatchInfoCollection();
        /**
         * Destructor.
         * @internal
         */
        virtual ~MatchInfoCollection();

#ifndef U_HIDE_INTERNAL_API
        /**
         * Adds a zone match.
         * @param nameType The name type.
         * @param matchLength The match length.
         * @param tzID The time zone ID.
         * @param status Receives the status
         * @internal
         */
        void addZone(UTimeZoneNameType nameType, int32_t matchLength,
            const UnicodeString& tzID, UErrorCode& status);

        /**
         * Adds a meata zone match.
         * @param nameType The name type.
         * @param matchLength The match length.
         * @param mzID The metazone ID.
         * @param status Receives the status
         * @internal
         */
        void addMetaZone(UTimeZoneNameType nameType, int32_t matchLength,
            const UnicodeString& mzID, UErrorCode& status);

        /**
         * Returns the number of entries available in this object.
         * @return The number of entries.
         * @internal
         */
        int32_t size() const;

        /**
         * Returns the time zone name type of a match at the specified index.
         * @param idx The index
         * @return The time zone name type. If the specified idx is out of range,
         *      it returns UTZNM_UNKNOWN.
         * @see UTimeZoneNameType
         * @internal
         */
        UTimeZoneNameType getNameTypeAt(int32_t idx) const;

        /**
         * Returns the match length of a match at the specified index.
         * @param idx The index
         * @return The match length. If the specified idx is out of range,
         *      it returns 0.
         * @internal
         */
        int32_t getMatchLengthAt(int32_t idx) const;

        /**
         * Gets the zone ID of a match at the specified index.
         * @param idx The index
         * @param tzID Receives the zone ID.
         * @return true if the zone ID was set to tzID.
         * @internal
         */
        UBool getTimeZoneIDAt(int32_t idx, UnicodeString& tzID) const;

        /**
         * Gets the metazone ID of a match at the specified index.
         * @param idx The index
         * @param mzID Receives the metazone ID
         * @return true if the meta zone ID was set to mzID.
         * @internal
         */
        UBool getMetaZoneIDAt(int32_t idx, UnicodeString& mzID) const;
#endif  /* U_HIDE_INTERNAL_API */

    private:
        UVector* fMatches;  // vector of MatchEntry

        UVector* matches(UErrorCode& status);
    };

    /**
     * Finds time zone name prefix matches for the input text at the
     * given offset and returns a collection of the matches.
     * @param text The text.
     * @param start The starting offset within the text.
     * @param types The set of name types represented by bitwise flags of UTimeZoneNameType enums,
     *              or UTZNM_UNKNOWN for all name types.
     * @param status Receives the status.
     * @return A collection of matches (owned by the caller), or nullptr if no matches are found.
     * @see UTimeZoneNameType
     * @see MatchInfoCollection
     * @internal
     */
    virtual MatchInfoCollection* find(const UnicodeString& text, int32_t start, uint32_t types, UErrorCode& status) const = 0;
};

U_NAMESPACE_END

#endif

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
