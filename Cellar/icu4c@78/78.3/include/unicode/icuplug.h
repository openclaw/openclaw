// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
*
*   Copyright (C) 2009-2015, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
******************************************************************************
*
*  FILE NAME : icuplug.h
*
*   Date         Name        Description
*   10/29/2009   sl          New.
******************************************************************************
*/

/**
 * \file
 * \brief C API: ICU Plugin API 
 *
 * <h2>C API: ICU Plugin API</h2>
 *
 * <p>C API allowing run-time loadable modules that extend or modify ICU functionality.</p>
 *
 * <h3>Loading and Configuration</h3>
 *
 * <p>At ICU startup time, the environment variable "ICU_PLUGINS" will be 
 * queried for a directory name.  If it is not set, the preprocessor symbol 
 * "DEFAULT_ICU_PLUGINS" will be checked for a default value.</p>
 *
 * <p>Within the above-named directory, the file  "icuplugins##.txt" will be 
 * opened, if present, where ## is the major+minor number of the currently 
 * running ICU (such as, 44 for ICU 4.4, thus icuplugins44.txt)</p>
 *
 * <p>The configuration file has this format:</p>
 *
 * <ul>
 * <li>Hash (#) begins a comment line</li>
 * 
 * <li>Non-comment lines have two or three components:
 * LIBRARYNAME     ENTRYPOINT     [ CONFIGURATION .. ]</li>
 *
 * <li>Tabs or spaces separate the three items.</li>
 *
 * <li>LIBRARYNAME is the name of a shared library, either a short name if 
 * it is on the loader path,  or a full pathname.</li>
 *
 * <li>ENTRYPOINT is the short (undecorated) symbol name of the plugin's 
 * entrypoint, as above.</li>
 *
 * <li>CONFIGURATION is the entire rest of the line . It's passed as-is to 
 * the plugin.</li>
 * </ul>
 *
 * <p>An example configuration file is, in its entirety:</p>
 *
 * \code
 * # this is icuplugins44.txt
 * testplug.dll    myPlugin        hello=world
 * \endcode
 * <p>Plugins are categorized as "high" or "low" level.  Low level are those 
 * which must be run BEFORE high level plugins, and before any operations 
 * which cause ICU to be 'initialized'.  If a plugin is low level but 
 * causes ICU to allocate memory or become initialized, that plugin is said 
 * to cause a 'level change'. </p>
 *
 * <p>At load time, ICU first queries all plugins to determine their level, 
 * then loads all 'low' plugins first, and then loads all 'high' plugins.  
 * Plugins are otherwise loaded in the order listed in the configuration file.</p>
 * 
 * <h3>Implementing a Plugin</h3>
 * \code
 * U_CAPI UPlugTokenReturn U_EXPORT2 
 * myPlugin (UPlugData *plug, UPlugReason reason, UErrorCode *status) {
 *   if(reason==UPLUG_REASON_QUERY) {
 *      uplug_setPlugName(plug, "Simple Plugin");
 *      uplug_setPlugLevel(plug, UPLUG_LEVEL_HIGH);
 *    } else if(reason==UPLUG_REASON_LOAD) {
 *       ... Set up some ICU things here.... 
 *    } else if(reason==UPLUG_REASON_UNLOAD) {
 *       ... unload, clean up ...
 *    }
 *   return UPLUG_TOKEN;
 *  }
 * \endcode
 *
 * <p>The UPlugData*  is an opaque pointer to the plugin-specific data, and is 
 * used in all other API calls.</p>
 *
 * <p>The API contract is:</p>
 * <ol><li>The plugin MUST always return UPLUG_TOKEN as a return value- to 
 * indicate that it is a valid plugin.</li>
 *
 * <li>When the 'reason' parameter is set to UPLUG_REASON_QUERY,  the 
 * plugin MUST call uplug_setPlugLevel() to indicate whether it is a high 
 * level or low level plugin.</li>
 *
 * <li>When the 'reason' parameter is UPLUG_REASON_QUERY, the plugin 
 * SHOULD call uplug_setPlugName to indicate a human readable plugin name.</li></ol>
 * 
 *
 * \internal ICU 4.4 Technology Preview
 */


#ifndef ICUPLUG_H
#define ICUPLUG_H

#include "unicode/utypes.h"


#if UCONFIG_ENABLE_PLUGINS || defined(U_IN_DOXYGEN)



/* === Basic types === */

#ifndef U_HIDE_INTERNAL_API
struct UPlugData;
/**
 * @{
 * Typedef for opaque structure passed to/from a plugin. 
 * Use the APIs to access it.
 * @internal ICU 4.4 Technology Preview
 */
typedef struct UPlugData UPlugData;

/** @} */

/**
 * Random Token to identify a valid ICU plugin. Plugins must return this 
 * from the entrypoint.
 * @internal ICU 4.4 Technology Preview
 */
#define UPLUG_TOKEN 0x54762486

/**
 * Max width of names, symbols, and configuration strings
 * @internal ICU 4.4 Technology Preview
 */
#define UPLUG_NAME_MAX              100


/**
 * Return value from a plugin entrypoint. 
 * Must always be set to UPLUG_TOKEN
 * @see UPLUG_TOKEN
 * @internal ICU 4.4 Technology Preview
 */
typedef uint32_t UPlugTokenReturn;

/**
 * Reason code for the entrypoint's call
 * @internal ICU 4.4 Technology Preview
 */
typedef enum {
    UPLUG_REASON_QUERY = 0,     /**< The plugin is being queried for info. **/
    UPLUG_REASON_LOAD = 1,     /**< The plugin is being loaded. **/
    UPLUG_REASON_UNLOAD = 2,   /**< The plugin is being unloaded. **/
    /**
     * Number of known reasons.
     * @internal The numeric value may change over time, see ICU ticket #12420.
     */
    UPLUG_REASON_COUNT
} UPlugReason;


/**
 * Level of plugin loading
 *     INITIAL:  UNKNOWN
 *       QUERY:   INVALID ->  { LOW | HIGH }
 *     ERR -> INVALID
 * @internal ICU 4.4 Technology Preview
 */
typedef enum {
    UPLUG_LEVEL_INVALID = 0,     /**< The plugin is invalid, hasn't called uplug_setLevel, or can't load. **/
    UPLUG_LEVEL_UNKNOWN = 1,     /**< The plugin is waiting to be installed. **/
    UPLUG_LEVEL_LOW     = 2,     /**< The plugin must be called before u_init completes **/
    UPLUG_LEVEL_HIGH    = 3,     /**< The plugin can run at any time. **/
    /**
     * Number of known levels.
     * @internal The numeric value may change over time, see ICU ticket #12420.
     */
    UPLUG_LEVEL_COUNT
} UPlugLevel;

/**
 * Entrypoint for an ICU plugin.
 * @param plug the UPlugData handle.
 * @param reason the reason code for the entrypoint's call.
 * @param status Standard ICU error code. Its input value must
 *               pass the U_SUCCESS() test, or else the function returns
 *               immediately. Check for U_FAILURE() on output or use with
 *               function chaining. (See User Guide for details.)
 * @return A valid plugin must return UPLUG_TOKEN
 * @internal ICU 4.4 Technology Preview
 */
typedef UPlugTokenReturn (U_EXPORT2 UPlugEntrypoint) (
                  UPlugData *plug,
                  UPlugReason reason,
                  UErrorCode *status);

/* === Needed for Implementing === */

/**
 * Request that this plugin not be unloaded at cleanup time.
 * This is appropriate for plugins which cannot be cleaned up.
 * @see u_cleanup()
 * @param plug plugin
 * @param dontUnload  set true if this plugin can't be unloaded
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI void U_EXPORT2 
uplug_setPlugNoUnload(UPlugData *plug, UBool dontUnload);

/**
 * Set the level of this plugin.
 * @param plug plugin data handle
 * @param level the level of this plugin
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI void U_EXPORT2
uplug_setPlugLevel(UPlugData *plug, UPlugLevel level);

/**
 * Get the level of this plugin.
 * @param plug plugin data handle
 * @return the level of this plugin
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI UPlugLevel U_EXPORT2
uplug_getPlugLevel(UPlugData *plug);

/**
 * Get the lowest level of plug which can currently load.
 * For example, if UPLUG_LEVEL_LOW is returned, then low level plugins may load
 * if UPLUG_LEVEL_HIGH is returned, then only high level plugins may load.
 * @return the lowest level of plug which can currently load
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI UPlugLevel U_EXPORT2
uplug_getCurrentLevel(void);


/**
 * Get plug load status
 * @return The error code of this plugin's load attempt.
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI UErrorCode U_EXPORT2
uplug_getPlugLoadStatus(UPlugData *plug); 

/**
 * Set the human-readable name of this plugin.
 * @param plug plugin data handle
 * @param name the name of this plugin. The first UPLUG_NAME_MAX characters willi be copied into a new buffer.
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI void U_EXPORT2
uplug_setPlugName(UPlugData *plug, const char *name);

/**
 * Get the human-readable name of this plugin.
 * @param plug plugin data handle
 * @return the name of this plugin
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI const char * U_EXPORT2
uplug_getPlugName(UPlugData *plug);

/**
 * Return the symbol name for this plugin, if known.
 * @param plug plugin data handle
 * @return the symbol name, or NULL
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI const char * U_EXPORT2
uplug_getSymbolName(UPlugData *plug);

/**
 * Return the library name for this plugin, if known.
 * @param plug plugin data handle
 * @param status error code
 * @return the library name, or NULL
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI const char * U_EXPORT2
uplug_getLibraryName(UPlugData *plug, UErrorCode *status);

/**
 * Return the library used for this plugin, if known.
 * Plugins could use this to load data out of their 
 * @param plug plugin data handle
 * @return the library, or NULL
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI void * U_EXPORT2
uplug_getLibrary(UPlugData *plug);

/**
 * Return the plugin-specific context data.
 * @param plug plugin data handle
 * @return the context, or NULL if not set
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI void * U_EXPORT2
uplug_getContext(UPlugData *plug);

/**
 * Set the plugin-specific context data.
 * @param plug plugin data handle
 * @param context new context to set
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI void U_EXPORT2
uplug_setContext(UPlugData *plug, void *context);


/**
 * Get the configuration string, if available.
 * The string is in the platform default codepage.
 * @param plug plugin data handle
 * @return configuration string, or else null.
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI const char * U_EXPORT2
uplug_getConfiguration(UPlugData *plug);

/**
 * Return all currently installed plugins, from newest to oldest
 * Usage Example:
 * \code
 *    UPlugData *plug = NULL;
 *    while(plug=uplug_nextPlug(plug)) {
 *        ... do something with 'plug' ...
 *    }
 * \endcode
 * Not thread safe- do not call while plugs are added or removed.
 * @param prior pass in 'NULL' to get the first (most recent) plug, 
 *  otherwise pass the value returned on a prior call to uplug_nextPlug
 * @return the next oldest plugin, or NULL if no more.
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI UPlugData* U_EXPORT2
uplug_nextPlug(UPlugData *prior);

/**
 * Inject a plugin as if it were loaded from a library.
 * This is useful for testing plugins. 
 * Note that it will have a 'NULL' library pointer associated
 * with it, and therefore no llibrary will be closed at cleanup time.
 * Low level plugins may not be able to load, as ordering can't be enforced.
 * @param entrypoint entrypoint to install
 * @param config user specified configuration string, if available, or NULL.
 * @param status error result
 * @return the new UPlugData associated with this plugin, or NULL if error.
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI UPlugData* U_EXPORT2
uplug_loadPlugFromEntrypoint(UPlugEntrypoint *entrypoint, const char *config, UErrorCode *status);


/**
 * Inject a plugin from a library, as if the information came from a config file.
 * Low level plugins may not be able to load, and ordering can't be enforced.
 * @param libName DLL name to load
 * @param sym symbol of plugin (UPlugEntrypoint function)
 * @param config configuration string, or NULL
 * @param status error result
 * @return the new UPlugData associated with this plugin, or NULL if error.
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI UPlugData* U_EXPORT2
uplug_loadPlugFromLibrary(const char *libName, const char *sym, const char *config, UErrorCode *status);

/**
 * Remove a plugin. 
 * Will request the plugin to be unloaded, and close the library if needed
 * @param plug plugin handle to close
 * @param status error result
 * @internal ICU 4.4 Technology Preview
 */
U_CAPI void U_EXPORT2
uplug_removePlug(UPlugData *plug, UErrorCode *status);
#endif  /* U_HIDE_INTERNAL_API */

#endif /* UCONFIG_ENABLE_PLUGINS */

#endif /* _ICUPLUG */

