// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
*
*   Copyright (C) 1999-2014, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
******************************************************************************
*   file name:  udata.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 1999oct25
*   created by: Markus W. Scherer
*/

#ifndef __UDATA_H__
#define __UDATA_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

U_CDECL_BEGIN

/**
 * \file
 * \brief C API: Data loading interface
 *
 * <h2>Information about data loading interface</h2>
 *
 * This API is used to find and efficiently load data for ICU and applications
 * using ICU. It provides an abstract interface that specifies a data type and
 * name to find and load the data. Normally this API is used by other ICU APIs
 * to load required data out of the ICU data library, but it can be used to
 * load data out of other places.
 *
 * See the User Guide Data Management chapter.
 */
 
#ifndef U_HIDE_INTERNAL_API
/**
 * Character used to separate package names from tree names 
 * @internal ICU 3.0
 */
#define U_TREE_SEPARATOR '-'

/**
 * String used to separate package names from tree names 
 * @internal ICU 3.0
 */
#define U_TREE_SEPARATOR_STRING "-"

/**
 * Character used to separate parts of entry names
 * @internal ICU 3.0
 */
#define U_TREE_ENTRY_SEP_CHAR '/'

/**
 * String used to separate parts of entry names
 * @internal ICU 3.0
 */
#define U_TREE_ENTRY_SEP_STRING "/"

/**
 * Alias for standard ICU data 
 * @internal ICU 3.0
 */
#define U_ICUDATA_ALIAS "ICUDATA"

#endif /* U_HIDE_INTERNAL_API */

/**
 * UDataInfo contains the properties about the requested data.
 * This is meta data.
 *
 * <p>This structure may grow in the future, indicated by the
 * <code>size</code> field.</p>
 *
 * <p>ICU data must be at least 8-aligned, and should be 16-aligned.
 * The UDataInfo struct begins 4 bytes after the start of the data item,
 * so it is 4-aligned.
 *
 * <p>The platform data property fields help determine if a data
 * file can be efficiently used on a given machine.
 * The particular fields are of importance only if the data
 * is affected by the properties - if there is integer data
 * with word sizes > 1 byte, char* text, or UChar* text.</p>
 *
 * <p>The implementation for the <code>udata_open[Choice]()</code>
 * functions may reject data based on the value in <code>isBigEndian</code>.
 * No other field is used by the <code>udata</code> API implementation.</p>
 *
 * <p>The <code>dataFormat</code> may be used to identify
 * the kind of data, e.g. a converter table.</p>
 *
 * <p>The <code>formatVersion</code> field should be used to
 * make sure that the format can be interpreted.
 * It may be a good idea to check only for the one or two highest
 * of the version elements to allow the data memory to
 * get more or somewhat rearranged contents, for as long
 * as the using code can still interpret the older contents.</p>
 *
 * <p>The <code>dataVersion</code> field is intended to be a
 * common place to store the source version of the data;
 * for data from the Unicode character database, this could
 * reflect the Unicode version.</p>
 *
 * @stable ICU 2.0
 */
typedef struct {
    /** sizeof(UDataInfo)
     *  @stable ICU 2.0 */
    uint16_t size;

    /** unused, set to 0 
     *  @stable ICU 2.0*/
    uint16_t reservedWord;

    /* platform data properties */
    /** 0 for little-endian machine, 1 for big-endian
     *  @stable ICU 2.0 */
    uint8_t isBigEndian;

    /** see U_CHARSET_FAMILY values in utypes.h 
     *  @stable ICU 2.0*/
    uint8_t charsetFamily;

    /** sizeof(UChar), one of { 1, 2, 4 } 
     *  @stable ICU 2.0*/
    uint8_t sizeofUChar;

    /** unused, set to 0 
     *  @stable ICU 2.0*/
    uint8_t reservedByte;

    /** data format identifier 
     *  @stable ICU 2.0*/
    uint8_t dataFormat[4];

    /** versions: [0] major [1] minor [2] milli [3] micro 
     *  @stable ICU 2.0*/
    uint8_t formatVersion[4];

    /** versions: [0] major [1] minor [2] milli [3] micro 
     *  @stable ICU 2.0*/
    uint8_t dataVersion[4];
} UDataInfo;

/* API for reading data -----------------------------------------------------*/

/**
 * Forward declaration of the data memory type.
 * @stable ICU 2.0
 */
typedef struct UDataMemory UDataMemory;

/**
 * Callback function for udata_openChoice().
 * @param context parameter passed into <code>udata_openChoice()</code>.
 * @param type The type of the data as passed into <code>udata_openChoice()</code>.
 *             It may be <code>NULL</code>.
 * @param name The name of the data as passed into <code>udata_openChoice()</code>.
 * @param pInfo A pointer to the <code>UDataInfo</code> structure
 *              of data that has been loaded and will be returned
 *              by <code>udata_openChoice()</code> if this function
 *              returns <code>true</code>.
 * @return true if the current data memory is acceptable
 * @stable ICU 2.0
 */
typedef UBool U_CALLCONV
UDataMemoryIsAcceptable(void *context,
                        const char *type, const char *name,
                        const UDataInfo *pInfo);


/**
 * Convenience function.
 * This function works the same as <code>udata_openChoice</code>
 * except that any data that matches the type and name
 * is assumed to be acceptable.
 * @param path Specifies an absolute path and/or a basename for the
 *             finding of the data in the file system.
 *             <code>NULL</code> for ICU data.
 * @param type A string that specifies the type of data to be loaded.
 *             For example, resource bundles are loaded with type "res",
 *             conversion tables with type "cnv".
 *             This may be <code>NULL</code> or empty.
 * @param name A string that specifies the name of the data.
 * @param pErrorCode An ICU UErrorCode parameter. It must not be <code>NULL</code>.
 * @return A pointer (handle) to a data memory object, or <code>NULL</code>
 *         if an error occurs. Call <code>udata_getMemory()</code>
 *         to get a pointer to the actual data.
 *
 * @see udata_openChoice
 * @stable ICU 2.0
 */
U_CAPI UDataMemory * U_EXPORT2
udata_open(const char *path, const char *type, const char *name,
           UErrorCode *pErrorCode);

/**
 * Data loading function.
 * This function is used to find and load efficiently data for
 * ICU and applications using ICU.
 * It provides an abstract interface that allows to specify a data
 * type and name to find and load the data.
 *
 * <p>The implementation depends on platform properties and user preferences
 * and may involve loading shared libraries (DLLs), mapping
 * files into memory, or fopen()/fread() files.
 * It may also involve using static memory or database queries etc.
 * Several or all data items may be combined into one entity
 * (DLL, memory-mappable file).</p>
 *
 * <p>The data is always preceded by a header that includes
 * a <code>UDataInfo</code> structure.
 * The caller's <code>isAcceptable()</code> function is called to make
 * sure that the data is useful. It may be called several times if it
 * rejects the data and there is more than one location with data
 * matching the type and name.</p>
 *
 * <p>If <code>path==NULL</code>, then ICU data is loaded.
 * Otherwise, it is separated into a basename and a basename-less directory string.
 * The basename is used as the data package name, and the directory is
 * logically prepended to the ICU data directory string.</p>
 *
 * <p>For details about ICU data loading see the User Guide
 * Data Management chapter. (https://unicode-org.github.io/icu/userguide/icu_data/)</p>
 *
 * @param path Specifies an absolute path and/or a basename for the
 *             finding of the data in the file system.
 *             <code>NULL</code> for ICU data.
 * @param type A string that specifies the type of data to be loaded.
 *             For example, resource bundles are loaded with type "res",
 *             conversion tables with type "cnv".
 *             This may be <code>NULL</code> or empty.
 * @param name A string that specifies the name of the data.
 * @param isAcceptable This function is called to verify that loaded data
 *                     is useful for the client code. If it returns false
 *                     for all data items, then <code>udata_openChoice()</code>
 *                     will return with an error.
 * @param context Arbitrary parameter to be passed into isAcceptable.
 * @param pErrorCode An ICU UErrorCode parameter. It must not be <code>NULL</code>.
 * @return A pointer (handle) to a data memory object, or <code>NULL</code>
 *         if an error occurs. Call <code>udata_getMemory()</code>
 *         to get a pointer to the actual data.
 * @stable ICU 2.0
 */
U_CAPI UDataMemory * U_EXPORT2
udata_openChoice(const char *path, const char *type, const char *name,
                 UDataMemoryIsAcceptable *isAcceptable, void *context,
                 UErrorCode *pErrorCode);

/**
 * Close the data memory.
 * This function must be called to allow the system to
 * release resources associated with this data memory.
 * @param pData The pointer to data memory object
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
udata_close(UDataMemory *pData);

/**
 * Get the pointer to the actual data inside the data memory.
 * The data is read-only.
 *
 * ICU data must be at least 8-aligned, and should be 16-aligned.
 *
 * @param pData The pointer to data memory object
 * @stable ICU 2.0
 */
U_CAPI const void * U_EXPORT2
udata_getMemory(UDataMemory *pData);

/**
 * Get the information from the data memory header.
 * This allows to get access to the header containing
 * platform data properties etc. which is not part of
 * the data itself and can therefore not be accessed
 * via the pointer that <code>udata_getMemory()</code> returns.
 *
 * @param pData pointer to the data memory object
 * @param pInfo pointer to a UDataInfo object;
 *              its <code>size</code> field must be set correctly,
 *              typically to <code>sizeof(UDataInfo)</code>.
 *
 * <code>*pInfo</code> will be filled with the UDataInfo structure
 * in the data memory object. If this structure is smaller than
 * <code>pInfo->size</code>, then the <code>size</code> will be
 * adjusted and only part of the structure will be filled.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
udata_getInfo(UDataMemory *pData, UDataInfo *pInfo);

/**
 * This function bypasses the normal ICU data loading process and
 * allows you to force ICU's system data to come out of a user-specified
 * area in memory.
 *
 * ICU data must be at least 8-aligned, and should be 16-aligned.
 * See https://unicode-org.github.io/icu/userguide/icu_data
 *
 * The format of this data is that of the icu common data file, as is
 * generated by the pkgdata tool with mode=common or mode=dll.
 * You can read in a whole common mode file and pass the address to the start of the
 * data, or (with the appropriate link options) pass in the pointer to
 * the data that has been loaded from a dll by the operating system,
 * as shown in this code:
 *
 *       extern const char U_IMPORT U_ICUDATA_ENTRY_POINT [];
 *        // U_ICUDATA_ENTRY_POINT is same as entry point specified to pkgdata tool
 *       UErrorCode  status = U_ZERO_ERROR;
 *
 *       udata_setCommonData(&U_ICUDATA_ENTRY_POINT, &status);
 *
 * It is important that the declaration be as above. The entry point
 * must not be declared as an extern void*.
 *
 * Starting with ICU 4.4, it is possible to set several data packages,
 * one per call to this function.
 * udata_open() will look for data in the multiple data packages in the order
 * in which they were set.
 * The position of the linked-in or default-name ICU .data package in the
 * search list depends on when the first data item is loaded that is not contained
 * in the already explicitly set packages.
 * If data was loaded implicitly before the first call to this function
 * (for example, via opening a converter, constructing a UnicodeString
 * from default-codepage data, using formatting or collation APIs, etc.),
 * then the default data will be first in the list.
 *
 * This function has no effect on application (non ICU) data.  See udata_setAppData()
 * for similar functionality for application data.
 *
 * @param data pointer to ICU common data
 * @param err outgoing error status <code>U_USING_DEFAULT_WARNING, U_UNSUPPORTED_ERROR</code>
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
udata_setCommonData(const void *data, UErrorCode *err);


/**
 * This function bypasses the normal ICU data loading process for application-specific
 * data and allows you to force the it to come out of a user-specified
 * pointer.
 *
 * ICU data must be at least 8-aligned, and should be 16-aligned.
 * See https://unicode-org.github.io/icu/userguide/icu_data
 *
 * The format of this data is that of the icu common data file, like 'icudt26l.dat'
 * or the corresponding shared library (DLL) file.
 * The application must read in or otherwise construct an image of the data and then
 * pass the address of it to this function.
 *
 *
 * Warning:  setAppData will set a U_USING_DEFAULT_WARNING code if
 *           data with the specified path that has already been opened, or
 *           if setAppData with the same path has already been called.
 *           Any such calls to setAppData will have no effect.
 *
 *
 * @param packageName the package name by which the application will refer
 *             to (open) this data
 * @param data pointer to the data
 * @param err outgoing error status <code>U_USING_DEFAULT_WARNING, U_UNSUPPORTED_ERROR</code>
 * @see udata_setCommonData
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
udata_setAppData(const char *packageName, const void *data, UErrorCode *err);

/**
 * Possible settings for udata_setFileAccess()
 * @see udata_setFileAccess
 * @stable ICU 3.4
 */
typedef enum UDataFileAccess {
    /** ICU looks for data in single files first, then in packages. (default) @stable ICU 3.4 */
    UDATA_FILES_FIRST,
    /** An alias for the default access mode. @stable ICU 3.4 */
    UDATA_DEFAULT_ACCESS = UDATA_FILES_FIRST,
    /** ICU only loads data from packages, not from single files. @stable ICU 3.4 */
    UDATA_ONLY_PACKAGES,
    /** ICU loads data from packages first, and only from single files
        if the data cannot be found in a package. @stable ICU 3.4 */
    UDATA_PACKAGES_FIRST,
    /** ICU does not access the file system for data loading. @stable ICU 3.4 */
    UDATA_NO_FILES,
#ifndef U_HIDE_DEPRECATED_API
    /**
     * Number of real UDataFileAccess values.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UDATA_FILE_ACCESS_COUNT
#endif  // U_HIDE_DEPRECATED_API
} UDataFileAccess;

/**
 * This function may be called to control how ICU loads data. It must be called
 * before any ICU data is loaded, including application data loaded with 
 * ures/ResourceBundle or udata APIs. This function is not multithread safe.  
 * The results of calling it while other threads are loading data are undefined.
 * @param access The type of file access to be used
 * @param status Error code.
 * @see UDataFileAccess
 * @stable ICU 3.4 
 */
U_CAPI void U_EXPORT2
udata_setFileAccess(UDataFileAccess access, UErrorCode *status);

U_CDECL_END

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUDataMemoryPointer
 * "Smart pointer" class, closes a UDataMemory via udata_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUDataMemoryPointer, UDataMemory, udata_close);

U_NAMESPACE_END

#endif  // U_SHOW_CPLUSPLUS_API

#endif
