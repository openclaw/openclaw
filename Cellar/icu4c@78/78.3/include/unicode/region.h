// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 *******************************************************************************
 * Copyright (C) 2014-2016, International Business Machines Corporation and others.
 * All Rights Reserved.
 *******************************************************************************
 */

#ifndef REGION_H
#define REGION_H

/**
 * \file 
 * \brief C++ API: Region classes (territory containment)
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/uregion.h"
#include "unicode/uobject.h"
#include "unicode/uniset.h"
#include "unicode/unistr.h"
#include "unicode/strenum.h"

U_NAMESPACE_BEGIN

/**
 * <code>Region</code> is the class representing a Unicode Region Code, also known as a 
 * Unicode Region Subtag, which is defined based upon the BCP 47 standard. We often think of
 * "regions" as "countries" when defining the characteristics of a locale.  Region codes There are different
 * types of region codes that are important to distinguish.
 * <p>
 *  Macroregion - A code for a "macro geographical (continental) region, geographical sub-region, or 
 *  selected economic and other grouping" as defined in 
 *  UN M.49 (http://unstats.un.org/unsd/methods/m49/m49regin.htm). 
 *  These are typically 3-digit codes, but contain some 2-letter codes, such as the LDML code QO 
 *  added for Outlying Oceania.  Not all UNM.49 codes are defined in LDML, but most of them are.
 *  Macroregions are represented in ICU by one of three region types: WORLD ( region code 001 ),
 *  CONTINENTS ( regions contained directly by WORLD ), and SUBCONTINENTS ( things contained directly
 *  by a continent ).
 *  <p>
 *  TERRITORY - A Region that is not a Macroregion. These are typically codes for countries, but also
 *  include areas that are not separate countries, such as the code "AQ" for Antarctica or the code 
 *  "HK" for Hong Kong (SAR China). Overseas dependencies of countries may or may not have separate 
 *  codes. The codes are typically 2-letter codes aligned with the ISO 3166 standard, but BCP47 allows
 *  for the use of 3-digit codes in the future.
 *  <p>
 *  UNKNOWN - The code ZZ is defined by Unicode LDML for use to indicate that the Region is unknown,
 *  or that the value supplied as a region was invalid.
 *  <p>
 *  DEPRECATED - Region codes that have been defined in the past but are no longer in modern usage,
 *  usually due to a country splitting into multiple territories or changing its name.
 *  <p>
 *  GROUPING - A widely understood grouping of territories that has a well defined membership such
 *  that a region code has been assigned for it.  Some of these are UNM.49 codes that do't fall into 
 *  the world/continent/sub-continent hierarchy, while others are just well known groupings that have
 *  their own region code. Region "EU" (European Union) is one such region code that is a grouping.
 *  Groupings will never be returned by the getContainingRegion() API, since a different type of region
 *  ( WORLD, CONTINENT, or SUBCONTINENT ) will always be the containing region instead.
 *
 * The Region class is not intended for public subclassing.
 *
 * @author       John Emmons
 * @stable ICU 51
 */

class U_I18N_API Region : public UObject {
public:
    /**
     * Destructor.
     * @stable ICU 51
     */
    virtual ~Region();

    /**
     * Returns true if the two regions are equal.
     * @stable ICU 51
     */
    bool operator==(const Region &that) const;

    /**
     * Returns true if the two regions are NOT equal; that is, if operator ==() returns false.
     * @stable ICU 51
     */
    bool operator!=(const Region &that) const;
 
    /**
     * Returns a pointer to a Region using the given region code.  The region code can be either 2-letter ISO code,
     * 3-letter ISO code,  UNM.49 numeric code, or other valid Unicode Region Code as defined by the LDML specification.
     * The identifier will be canonicalized internally using the supplemental metadata as defined in the CLDR.
     * If the region code is nullptr or not recognized, the appropriate error code will be set ( U_ILLEGAL_ARGUMENT_ERROR )
     * @stable ICU 51 
     */
    static const Region* U_EXPORT2 getInstance(const char *region_code, UErrorCode &status);

    /**
     * Returns a pointer to a Region using the given numeric region code. If the numeric region code is not recognized,
     * the appropriate error code will be set ( U_ILLEGAL_ARGUMENT_ERROR ).
     * @stable ICU 51 
     */
    static const Region* U_EXPORT2 getInstance (int32_t code, UErrorCode &status);

    /**
     * Returns an enumeration over the IDs of all known regions that match the given type.
     * @stable ICU 55
     */
    static StringEnumeration* U_EXPORT2 getAvailable(URegionType type, UErrorCode &status);
   
    /**
     * Returns a pointer to the region that contains this region.  Returns nullptr if this region is code "001" (World)
     * or "ZZ" (Unknown region). For example, calling this method with region "IT" (Italy) returns the
     * region "039" (Southern Europe).
     * @stable ICU 51 
     */
    const Region* getContainingRegion() const;

    /**
     * Return a pointer to the region that geographically contains this region and matches the given type,
     * moving multiple steps up the containment chain if necessary.  Returns nullptr if no containing region can be found
     * that matches the given type. Note: The URegionTypes = "URGN_GROUPING", "URGN_DEPRECATED", or "URGN_UNKNOWN"
     * are not appropriate for use in this API. nullptr will be returned in this case. For example, calling this method
     * with region "IT" (Italy) for type "URGN_CONTINENT" returns the region "150" ( Europe ).
     * @stable ICU 51 
     */
    const Region* getContainingRegion(URegionType type) const;

    /**
     * Return an enumeration over the IDs of all the regions that are immediate children of this region in the
     * region hierarchy. These returned regions could be either macro regions, territories, or a mixture of the two,
     * depending on the containment data as defined in CLDR.  This API may return nullptr if this region doesn't have
     * any sub-regions. For example, calling this method with region "150" (Europe) returns an enumeration containing
     * the various sub regions of Europe - "039" (Southern Europe) - "151" (Eastern Europe) - "154" (Northern Europe)
     * and "155" (Western Europe).
     * @stable ICU 55
     */
    StringEnumeration* getContainedRegions(UErrorCode &status) const;

    /**
     * Returns an enumeration over the IDs of all the regions that are children of this region anywhere in the region
     * hierarchy and match the given type.  This API may return an empty enumeration if this region doesn't have any
     * sub-regions that match the given type. For example, calling this method with region "150" (Europe) and type
     * "URGN_TERRITORY" returns a set containing all the territories in Europe ( "FR" (France) - "IT" (Italy) - "DE" (Germany) etc. )
     * @stable ICU 55
     */
    StringEnumeration* getContainedRegions( URegionType type, UErrorCode &status ) const;
 
    /**
     * Returns true if this region contains the supplied other region anywhere in the region hierarchy.
     * @stable ICU 51 
     */
    UBool contains(const Region &other) const;

    /**
     * For deprecated regions, return an enumeration over the IDs of the regions that are the preferred replacement
     * regions for this region.  Returns null for a non-deprecated region.  For example, calling this method with region
     * "SU" (Soviet Union) would return a list of the regions containing "RU" (Russia), "AM" (Armenia), "AZ" (Azerbaijan), etc...
     * @stable ICU 55 
     */
    StringEnumeration* getPreferredValues(UErrorCode &status) const;

    /**
     * Return this region's canonical region code.
     * @stable ICU 51 
     */
    const char* getRegionCode() const;

    /**
     * Return this region's numeric code.
     * Returns a negative value if the given region does not have a numeric code assigned to it.
     * @stable ICU 51 
     */
    int32_t getNumericCode() const;

    /**
     * Returns the region type of this region.
     * @stable ICU 51 
     */
    URegionType getType() const;

#ifndef U_HIDE_INTERNAL_API
    /**
     * Cleans up statically allocated memory.
     * @internal 
     */
    static void cleanupRegionData();
#endif  /* U_HIDE_INTERNAL_API */

private:
    char id[4];
    UnicodeString idStr;
    int32_t code;
    URegionType fType;
    Region *containingRegion;
    UVector *containedRegions;
    UVector *preferredValues;

    /**
     * Default Constructor. Internal - use factory methods only.
     */
    Region();


    /*
     * Initializes the region data from the ICU resource bundles.  The region data
     * contains the basic relationships such as which regions are known, what the numeric
     * codes are, any known aliases, and the territory containment data.
     * 
     * If the region data has already loaded, then this method simply returns without doing
     * anything meaningful.
     */

    static void U_CALLCONV loadRegionData(UErrorCode &status);

};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // REGION_H

//eof
