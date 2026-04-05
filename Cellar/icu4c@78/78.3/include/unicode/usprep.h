// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 *******************************************************************************
 *
 *   Copyright (C) 2003-2014, International Business Machines
 *   Corporation and others.  All Rights Reserved.
 *
 *******************************************************************************
 *   file name:  usprep.h
 *   encoding:   UTF-8
 *   tab size:   8 (not used)
 *   indentation:4
 *
 *   created on: 2003jul2
 *   created by: Ram Viswanadha
 */

#ifndef __USPREP_H__
#define __USPREP_H__

/**
 * \file 
 * \brief C API: Implements the StringPrep algorithm.
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 *
 * StringPrep API implements the StingPrep framework as described by RFC 3454.
 * StringPrep prepares Unicode strings for use in network protocols.
 * Profiles of StingPrep are set of rules and data according to with the
 * Unicode Strings are prepared. Each profiles contains tables which describe
 * how a code point should be treated. The tables are broadly classified into
 * <ul>
 *     <li> Unassigned Table: Contains code points that are unassigned 
 *          in the Unicode Version supported by StringPrep. Currently 
 *          RFC 3454 supports Unicode 3.2. </li>
 *     <li> Prohibited Table: Contains code points that are prohibited from
 *          the output of the StringPrep processing function. </li>
 *     <li> Mapping Table: Contains code points that are deleted from the output or case mapped. </li>
 * </ul>
 * 
 * The procedure for preparing Unicode strings:
 * <ol>
 *      <li> Map: For each character in the input, check if it has a mapping
 *           and, if so, replace it with its mapping. </li>
 *      <li> Normalize: Possibly normalize the result of step 1 using Unicode
 *           normalization. </li>
 *      <li> Prohibit: Check for any characters that are not allowed in the
 *        output.  If any are found, return an error.</li>
 *      <li> Check bidi: Possibly check for right-to-left characters, and if
 *           any are found, make sure that the whole string satisfies the
 *           requirements for bidirectional strings.  If the string does not
 *           satisfy the requirements for bidirectional strings, return an
 *           error.  </li>
 * </ol>
 * @author Ram Viswanadha
 */
#if !UCONFIG_NO_IDNA

#include "unicode/parseerr.h"

/**
 * The StringPrep profile
 * @stable ICU 2.8
 */
typedef struct UStringPrepProfile UStringPrepProfile;


/** 
 * Option to prohibit processing of unassigned code points in the input
 * 
 * @see  usprep_prepare
 * @stable ICU 2.8
 */
#define USPREP_DEFAULT 0x0000

/** 
 * Option to allow processing of unassigned code points in the input
 * 
 * @see  usprep_prepare
 * @stable ICU 2.8
 */
#define USPREP_ALLOW_UNASSIGNED 0x0001

/**
 * enums for the standard stringprep profile types
 * supported by usprep_openByType.
 * @see usprep_openByType
 * @stable ICU 4.2
 */
typedef enum UStringPrepProfileType {
    /**
     * RFC3491 Nameprep
     * @stable ICU 4.2
     */
    USPREP_RFC3491_NAMEPREP,
    /**
     * RFC3530 nfs4_cs_prep
     * @stable ICU 4.2
     */
	USPREP_RFC3530_NFS4_CS_PREP,
    /**
     * RFC3530 nfs4_cs_prep with case insensitive option
     * @stable ICU 4.2
     */
	USPREP_RFC3530_NFS4_CS_PREP_CI,
    /**
     * RFC3530 nfs4_cis_prep
     * @stable ICU 4.2
     */
	USPREP_RFC3530_NFS4_CIS_PREP,
    /**
     * RFC3530 nfs4_mixed_prep for prefix
     * @stable ICU 4.2
     */
	USPREP_RFC3530_NFS4_MIXED_PREP_PREFIX,
    /**
     * RFC3530 nfs4_mixed_prep for suffix
     * @stable ICU 4.2
     */
	USPREP_RFC3530_NFS4_MIXED_PREP_SUFFIX,
    /**
     * RFC3722 iSCSI
     * @stable ICU 4.2
     */
	USPREP_RFC3722_ISCSI,
    /**
     * RFC3920 XMPP Nodeprep
     * @stable ICU 4.2
     */
	USPREP_RFC3920_NODEPREP,
    /**
     * RFC3920 XMPP Resourceprep
     * @stable ICU 4.2
     */
	USPREP_RFC3920_RESOURCEPREP,
    /**
     * RFC4011 Policy MIB Stringprep
     * @stable ICU 4.2
     */
	USPREP_RFC4011_MIB,
    /**
     * RFC4013 SASLprep
     * @stable ICU 4.2
     */
    USPREP_RFC4013_SASLPREP,
    /**
     * RFC4505 trace
     * @stable ICU 4.2
     */
	USPREP_RFC4505_TRACE,
    /**
     * RFC4518 LDAP
     * @stable ICU 4.2
     */
	USPREP_RFC4518_LDAP,
    /**
     * RFC4518 LDAP for case ignore, numeric and stored prefix
     * matching rules
     * @stable ICU 4.2
     */
	USPREP_RFC4518_LDAP_CI
} UStringPrepProfileType;

/**
 * Creates a StringPrep profile from the data file.
 *
 * @param path      string containing the full path pointing to the directory
 *                  where the profile reside followed by the package name
 *                  e.g. "/usr/resource/my_app/profiles/mydata" on a Unix system.
 *                  if NULL, ICU default data files will be used.
 * @param fileName  name of the profile file to be opened
 * @param status    ICU error code in/out parameter. Must not be NULL.
 *                  Must fulfill U_SUCCESS before the function call.
 * @return Pointer to UStringPrepProfile that is opened. Should be closed by
 * calling usprep_close()
 * @see usprep_close()
 * @stable ICU 2.8
 */
U_CAPI UStringPrepProfile* U_EXPORT2
usprep_open(const char* path, 
            const char* fileName,
            UErrorCode* status);

/**
 * Creates a StringPrep profile for the specified profile type.
 *
 * @param type		The profile type
 * @param status    ICU error code in/out parameter. Must not be NULL.
 *                  Must fulfill U_SUCCESS before the function call.
 * @return          Pointer to UStringPrepProfile that is opened. Should be closed by
 *                  calling usprep_close()
 * @see usprep_close()
 * @stable ICU 4.2
 */
U_CAPI UStringPrepProfile* U_EXPORT2
usprep_openByType(UStringPrepProfileType type,
				  UErrorCode* status);

/**
 * Closes the profile
 * @param profile The profile to close
 * @stable ICU 2.8
 */
U_CAPI void U_EXPORT2
usprep_close(UStringPrepProfile* profile);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUStringPrepProfilePointer
 * "Smart pointer" class, closes a UStringPrepProfile via usprep_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUStringPrepProfilePointer, UStringPrepProfile, usprep_close);

U_NAMESPACE_END

#endif

/**
 * Prepare the input buffer for use in applications with the given profile. This operation maps, normalizes(NFKC),
 * checks for prohibited and BiDi characters in the order defined by RFC 3454
 * depending on the options specified in the profile.
 *
 * @param prep          The profile to use 
 * @param src           Pointer to UChar buffer containing the string to prepare
 * @param srcLength     Number of characters in the source string
 * @param dest          Pointer to the destination buffer to receive the output
 * @param destCapacity  The capacity of destination array
 * @param options       A bit set of options:
 *
 *  - USPREP_DEFAULT            Prohibit processing of unassigned code points in the input
 *
 *  - USPREP_ALLOW_UNASSIGNED   Treat the unassigned code points are in the input 
 *                              as normal Unicode code points.
 *
 * @param parseError        Pointer to UParseError struct to receive information on position 
 *                          of error if an error is encountered. Can be NULL.
 * @param status            ICU in/out error code parameter.
 *                          U_INVALID_CHAR_FOUND if src contains
 *                          unmatched single surrogates.
 *                          U_INDEX_OUTOFBOUNDS_ERROR if src contains
 *                          too many code points.
 *                          U_BUFFER_OVERFLOW_ERROR if destCapacity is not enough
 * @return The number of UChars in the destination buffer
 * @stable ICU 2.8
 */

U_CAPI int32_t U_EXPORT2
usprep_prepare(   const UStringPrepProfile* prep,
                  const UChar* src, int32_t srcLength, 
                  UChar* dest, int32_t destCapacity,
                  int32_t options,
                  UParseError* parseError,
                  UErrorCode* status );


#endif /* #if !UCONFIG_NO_IDNA */

#endif
