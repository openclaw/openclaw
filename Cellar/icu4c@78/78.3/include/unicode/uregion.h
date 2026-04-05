// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*****************************************************************************************
* Copyright (C) 2014, International Business Machines
* Corporation and others. All Rights Reserved.
*****************************************************************************************
*/

#ifndef UREGION_H
#define UREGION_H

#include "unicode/utypes.h"
#include "unicode/uenum.h"

/**
 * \file
 * \brief C API: URegion (territory containment and mapping)
 *
 * URegion objects represent data associated with a particular Unicode Region Code, also known as a 
 * Unicode Region Subtag, which is defined based upon the BCP 47 standard. These include:
 * * Two-letter codes defined by ISO 3166-1, with special LDML treatment of certain private-use or
 *   reserved codes;
 * * A subset of 3-digit numeric codes defined by UN M.49.
 * URegion objects can also provide mappings to and from additional codes. There are different types
 * of regions that are important to distinguish:
 * <p>
 * Macroregion - A code for a "macro geographical (continental) region, geographical sub-region, or 
 * selected economic and other grouping" as defined in UN M.49. These are typically 3-digit codes,
 * but contain some 2-letter codes for LDML extensions, such as "QO" for Outlying Oceania.
 * Macroregions are represented in ICU by one of three region types: WORLD (code 001),
 * CONTINENTS (regions contained directly by WORLD), and SUBCONTINENTS (regions contained directly
 * by a continent ).
 * <p>
 * TERRITORY - A Region that is not a Macroregion. These are typically codes for countries, but also
 * include areas that are not separate countries, such as the code "AQ" for Antarctica or the code 
 * "HK" for Hong Kong (SAR China). Overseas dependencies of countries may or may not have separate 
 * codes. The codes are typically 2-letter codes aligned with ISO 3166, but BCP47 allows for the use
 * of 3-digit codes in the future.
 * <p>
 * UNKNOWN - The code ZZ is defined by Unicode LDML for use in indicating that region is unknown,
 * or that the value supplied as a region was invalid.
 * <p>
 * DEPRECATED - Region codes that have been defined in the past but are no longer in modern usage,
 * usually due to a country splitting into multiple territories or changing its name.
 * <p>
 * GROUPING - A widely understood grouping of territories that has a well defined membership such
 * that a region code has been assigned for it.  Some of these are UN M.49 codes that don't fall into 
 * the world/continent/sub-continent hierarchy, while others are just well-known groupings that have
 * their own region code. Region "EU" (European Union) is one such region code that is a grouping.
 * Groupings will never be returned by the uregion_getContainingRegion, since a different type of region
 * (WORLD, CONTINENT, or SUBCONTINENT) will always be the containing region instead.
 *
 * URegion objects are const/immutable, owned and maintained by ICU itself, so there are not functions
 * to open or close them.
 */

/**
 * URegionType is an enumeration defining the different types of regions.  Current possible
 * values are URGN_WORLD, URGN_CONTINENT, URGN_SUBCONTINENT, URGN_TERRITORY, URGN_GROUPING,
 * URGN_DEPRECATED, and URGN_UNKNOWN.
 * 
 * @stable ICU 51 
 */
typedef enum URegionType {
    /**
     * Type representing the unknown region.
     * @stable ICU 51 
     */
    URGN_UNKNOWN,

    /**
     * Type representing a territory.
     * @stable ICU 51 
     */
    URGN_TERRITORY,

    /**
     * Type representing the whole world.
     * @stable ICU 51 
     */
    URGN_WORLD,

    /**
     * Type representing a continent.
     * @stable ICU 51 
     */
    URGN_CONTINENT,

    /**
     * Type representing a sub-continent.
     * @stable ICU 51 
     */
    URGN_SUBCONTINENT,

    /**
     * Type representing a grouping of territories that is not to be used in
     * the normal WORLD/CONTINENT/SUBCONTINENT/TERRITORY containment tree.
     * @stable ICU 51 
     */
    URGN_GROUPING,

    /**
     * Type representing a region whose code has been deprecated, usually
     * due to a country splitting into multiple territories or changing its name.
     * @stable ICU 51 
     */
    URGN_DEPRECATED,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal URegionType value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    URGN_LIMIT
#endif  /* U_HIDE_DEPRECATED_API */
} URegionType;

#if !UCONFIG_NO_FORMATTING

/**
 * Opaque URegion object for use in C programs.
 * @stable ICU 52
 */
struct URegion;
typedef struct URegion URegion; /**< @stable ICU 52 */

/**
 * Returns a pointer to a URegion for the specified region code: A 2-letter or 3-letter ISO 3166
 * code, UN M.49 numeric code (superset of ISO 3166 numeric codes), or other valid Unicode Region
 * Code as defined by the LDML specification. The code will be canonicalized internally. If the
 * region code is NULL or not recognized, the appropriate error code will be set
 * (U_ILLEGAL_ARGUMENT_ERROR).
 * @stable ICU 52
 */
U_CAPI const URegion* U_EXPORT2
uregion_getRegionFromCode(const char *regionCode, UErrorCode *status);

/**
 * Returns a pointer to a URegion for the specified numeric region code. If the numeric region
 * code is not recognized, the appropriate error code will be set (U_ILLEGAL_ARGUMENT_ERROR).
 * @stable ICU 52
 */
U_CAPI const URegion* U_EXPORT2
uregion_getRegionFromNumericCode (int32_t code, UErrorCode *status);

/**
 * Returns an enumeration over the canonical codes of all known regions that match the given type.
 * The enumeration must be closed with with uenum_close().
 * @stable ICU 52
 */
U_CAPI UEnumeration* U_EXPORT2
uregion_getAvailable(URegionType type, UErrorCode *status);

/**
 * Returns true if the specified uregion is equal to the specified otherRegion.
 * @stable ICU 52
 */
U_CAPI UBool U_EXPORT2
uregion_areEqual(const URegion* uregion, const URegion* otherRegion);

/**
 * Returns a pointer to the URegion that contains the specified uregion. Returns NULL if the
 * specified uregion is code "001" (World) or "ZZ" (Unknown region). For example, calling
 * this method with region "IT" (Italy) returns the URegion for "039" (Southern Europe).
 * @stable ICU 52
 */
U_CAPI const URegion* U_EXPORT2
uregion_getContainingRegion(const URegion* uregion);

/**
 * Return a pointer to the URegion that geographically contains this uregion and matches the
 * specified type, moving multiple steps up the containment chain if necessary. Returns NULL if no
 * containing region can be found that matches the specified type. Will return NULL if URegionType
 * is URGN_GROUPING, URGN_DEPRECATED, or URGN_UNKNOWN which are not appropriate for this API.
 * For example, calling this method with uregion "IT" (Italy) for type URGN_CONTINENT returns the
 * URegion "150" (Europe).
 * @stable ICU 52
 */
U_CAPI const URegion* U_EXPORT2
uregion_getContainingRegionOfType(const URegion* uregion, URegionType type);

/**
 * Return an enumeration over the canonical codes of all the regions that are immediate children
 * of the specified uregion in the region hierarchy. These returned regions could be either macro
 * regions, territories, or a mixture of the two, depending on the containment data as defined in
 * CLDR. This API returns NULL if this uregion doesn't have any sub-regions. For example, calling
 * this function for uregion "150" (Europe) returns an enumeration containing the various
 * sub-regions of Europe: "039" (Southern Europe), "151" (Eastern Europe), "154" (Northern Europe),
 * and "155" (Western Europe). The enumeration must be closed with with uenum_close().
 * @stable ICU 52
 */
U_CAPI UEnumeration* U_EXPORT2
uregion_getContainedRegions(const URegion* uregion, UErrorCode *status);

/**
 * Returns an enumeration over the canonical codes of all the regions that are children of the
 * specified uregion anywhere in the region hierarchy and match the given type. This API may return
 * an empty enumeration if this uregion doesn't have any sub-regions that match the given type.
 * For example, calling this method with region "150" (Europe) and type URGN_TERRITORY" returns an
 * enumeration containing all the territories in Europe: "FR" (France), "IT" (Italy), "DE" (Germany),
 * etc. The enumeration must be closed with with uenum_close().
 * @stable ICU 52
 */
U_CAPI UEnumeration* U_EXPORT2
uregion_getContainedRegionsOfType(const URegion* uregion, URegionType type, UErrorCode *status);

/**
 * Returns true if the specified uregion contains the specified otherRegion anywhere in the region
 * hierarchy.
 * @stable ICU 52
 */
U_CAPI UBool U_EXPORT2
uregion_contains(const URegion* uregion, const URegion* otherRegion);

/**
 * If the specified uregion is deprecated, returns an enumeration over the canonical codes of the
 * regions that are the preferred replacement regions for the specified uregion. If the specified
 * uregion is not deprecated, returns NULL. For example, calling this method with uregion
 * "SU" (Soviet Union) returns a list of the regions containing "RU" (Russia), "AM" (Armenia),
 * "AZ" (Azerbaijan), etc... The enumeration must be closed with with uenum_close().
 * @stable ICU 52
 */
U_CAPI UEnumeration* U_EXPORT2
uregion_getPreferredValues(const URegion* uregion, UErrorCode *status);

/**
 * Returns the specified uregion's canonical code.
 * @stable ICU 52
 */
U_CAPI const char* U_EXPORT2
uregion_getRegionCode(const URegion* uregion);

/**
 * Returns the specified uregion's numeric code, or a negative value if there is no numeric code
 * for the specified uregion.
 * @stable ICU 52
 */
U_CAPI int32_t U_EXPORT2
uregion_getNumericCode(const URegion* uregion);

/**
 * Returns the URegionType of the specified uregion.
 * @stable ICU 52
 */
U_CAPI URegionType U_EXPORT2
uregion_getType(const URegion* uregion);


#endif /* #if !UCONFIG_NO_FORMATTING */

#endif
