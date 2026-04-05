/*
  Simple DirectMedia Layer
  Copyright (C) 1997-2025 Sam Lantinga <slouken@libsdl.org>

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.
*/

/**
 * # CategorySystem
 *
 * Include file for platform specific SDL API functions
 */

#ifndef SDL_system_h_
#define SDL_system_h_

#include "SDL_stdinc.h"
#include "SDL_keyboard.h"
#include "SDL_render.h"
#include "SDL_video.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif


/* Platform specific functions for Windows */
#if defined(__WIN32__) || defined(__GDK__)
	
typedef void (SDLCALL * SDL_WindowsMessageHook)(void *userdata, void *hWnd, unsigned int message, Uint64 wParam, Sint64 lParam);

/**
 * Set a callback for every Windows message, run before TranslateMessage().
 *
 * \param callback The SDL_WindowsMessageHook function to call.
 * \param userdata a pointer to pass to every iteration of `callback`.
 *
 * \since This function is available since SDL 2.0.4.
 */
extern DECLSPEC void SDLCALL SDL_SetWindowsMessageHook(SDL_WindowsMessageHook callback, void *userdata);

#endif /* defined(__WIN32__) || defined(__GDK__) */

#if defined(__WIN32__) || defined(__WINGDK__)

/**
 * Get the D3D9 adapter index that matches the specified display index.
 *
 * The returned adapter index can be passed to `IDirect3D9::CreateDevice` and
 * controls on which monitor a full screen application will appear.
 *
 * \param displayIndex the display index for which to get the D3D9 adapter
 *                     index.
 * \returns the D3D9 adapter index on success or a negative error code on
 *          failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.1.
 */
extern DECLSPEC int SDLCALL SDL_Direct3D9GetAdapterIndex( int displayIndex );

typedef struct IDirect3DDevice9 IDirect3DDevice9;

/**
 * Get the D3D9 device associated with a renderer.
 *
 * Once you are done using the device, you should release it to avoid a
 * resource leak.
 *
 * \param renderer the renderer from which to get the associated D3D device.
 * \returns the D3D9 device associated with given renderer or NULL if it is
 *          not a D3D9 renderer; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.1.
 */
extern DECLSPEC IDirect3DDevice9* SDLCALL SDL_RenderGetD3D9Device(SDL_Renderer * renderer);

typedef struct ID3D11Device ID3D11Device;

/**
 * Get the D3D11 device associated with a renderer.
 *
 * Once you are done using the device, you should release it to avoid a
 * resource leak.
 *
 * \param renderer the renderer from which to get the associated D3D11 device.
 * \returns the D3D11 device associated with given renderer or NULL if it is
 *          not a D3D11 renderer; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.16.
 */
extern DECLSPEC ID3D11Device* SDLCALL SDL_RenderGetD3D11Device(SDL_Renderer * renderer);

#endif /* defined(__WIN32__) || defined(__WINGDK__) */

#if defined(__WIN32__) || defined(__GDK__)

typedef struct ID3D12Device ID3D12Device;

/**
 * Get the D3D12 device associated with a renderer.
 *
 * Once you are done using the device, you should release it to avoid a
 * resource leak.
 *
 * \param renderer the renderer from which to get the associated D3D12 device.
 * \returns the D3D12 device associated with given renderer or NULL if it is
 *          not a D3D12 renderer; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.24.0.
 */
extern DECLSPEC ID3D12Device* SDLCALL SDL_RenderGetD3D12Device(SDL_Renderer* renderer);

#endif /* defined(__WIN32__) || defined(__GDK__) */

#if defined(__WIN32__) || defined(__WINGDK__)

/**
 * Get the DXGI Adapter and Output indices for the specified display index.
 *
 * The DXGI Adapter and Output indices can be passed to `EnumAdapters` and
 * `EnumOutputs` respectively to get the objects required to create a DX10 or
 * DX11 device and swap chain.
 *
 * Before SDL 2.0.4 this function did not return a value. Since SDL 2.0.4 it
 * returns an SDL_bool.
 *
 * \param displayIndex the display index for which to get both indices.
 * \param adapterIndex a pointer to be filled in with the adapter index.
 * \param outputIndex a pointer to be filled in with the output index.
 * \returns SDL_TRUE on success or SDL_FALSE on failure; call SDL_GetError()
 *          for more information.
 *
 * \since This function is available since SDL 2.0.2.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_DXGIGetOutputInfo( int displayIndex, int *adapterIndex, int *outputIndex );

#endif /* defined(__WIN32__) || defined(__WINGDK__) */

/* Platform specific functions for Linux */
#ifdef __LINUX__

/**
 * Sets the UNIX nice value for a thread.
 *
 * This uses setpriority() if possible, and RealtimeKit if available.
 *
 * \param threadID the Unix thread ID to change priority of.
 * \param priority The new, Unix-specific, priority value.
 * \returns 0 on success, or -1 on error.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC int SDLCALL SDL_LinuxSetThreadPriority(Sint64 threadID, int priority);

/**
 * Sets the priority (not nice level) and scheduling policy for a thread.
 *
 * This uses setpriority() if possible, and RealtimeKit if available.
 *
 * \param threadID The Unix thread ID to change priority of.
 * \param sdlPriority The new SDL_ThreadPriority value.
 * \param schedPolicy The new scheduling policy (SCHED_FIFO, SCHED_RR,
 *                    SCHED_OTHER, etc...).
 * \returns 0 on success, or -1 on error.
 *
 * \since This function is available since SDL 2.0.18.
 */
extern DECLSPEC int SDLCALL SDL_LinuxSetThreadPriorityAndPolicy(Sint64 threadID, int sdlPriority, int schedPolicy);
 
#endif /* __LINUX__ */
	
/* Platform specific functions for iOS */
#ifdef __IPHONEOS__

typedef void (SDLCALL *SDL_iOSAnimationCallback)(void*);

/**
 * Use this function to set the animation callback on Apple iOS.
 *
 * The function prototype for `callback` is:
 *
 * ```c
 * void callback(void* callbackParam);
 * ```
 *
 * Where its parameter, `callbackParam`, is what was passed as `callbackParam`
 * to SDL_iPhoneSetAnimationCallback().
 *
 * This function is only available on Apple iOS.
 *
 * For more information see:
 * https://github.com/libsdl-org/SDL/blob/main/docs/README-ios.md
 *
 * This functions is also accessible using the macro
 * SDL_iOSSetAnimationCallback() since SDL 2.0.4.
 *
 * \param window the window for which the animation callback should be set.
 * \param interval the number of frames after which **callback** will be
 *                 called.
 * \param callback the function to call for every frame.
 * \param callbackParam a pointer that is passed to `callback`.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_iPhoneSetEventPump
 */
extern DECLSPEC int SDLCALL SDL_iPhoneSetAnimationCallback(SDL_Window * window, int interval, SDL_iOSAnimationCallback callback, void *callbackParam);

#define SDL_iOSSetAnimationCallback(window, interval, callback, callbackParam) SDL_iPhoneSetAnimationCallback(window, interval, callback, callbackParam)


/**
 * Use this function to enable or disable the SDL event pump on Apple iOS.
 *
 * This function is only available on Apple iOS.
 *
 * This functions is also accessible using the macro SDL_iOSSetEventPump()
 * since SDL 2.0.4.
 *
 * \param enabled SDL_TRUE to enable the event pump, SDL_FALSE to disable it.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_iPhoneSetAnimationCallback
 */
extern DECLSPEC void SDLCALL SDL_iPhoneSetEventPump(SDL_bool enabled);

#define SDL_iOSSetEventPump(enabled) SDL_iPhoneSetEventPump(enabled)

/* end of iOS-specific functions. */
#endif /* __IPHONEOS__ */


/* Platform specific functions for Android */
#ifdef __ANDROID__

/**
 * Get the Android Java Native Interface Environment of the current thread.
 *
 * This is the JNIEnv one needs to access the Java virtual machine from native
 * code, and is needed for many Android APIs to be usable from C.
 *
 * The prototype of the function in SDL's code actually declare a void* return
 * type, even if the implementation returns a pointer to a JNIEnv. The
 * rationale being that the SDL headers can avoid including jni.h.
 *
 * \returns a pointer to Java native interface object (JNIEnv) to which the
 *          current thread is attached, or 0 on error.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_AndroidGetActivity
 */
extern DECLSPEC void * SDLCALL SDL_AndroidGetJNIEnv(void);

/**
 * Retrieve the Java instance of the Android activity class.
 *
 * The prototype of the function in SDL's code actually declares a void*
 * return type, even if the implementation returns a jobject. The rationale
 * being that the SDL headers can avoid including jni.h.
 *
 * The jobject returned by the function is a local reference and must be
 * released by the caller. See the PushLocalFrame() and PopLocalFrame() or
 * DeleteLocalRef() functions of the Java native interface:
 *
 * https://docs.oracle.com/javase/1.5.0/docs/guide/jni/spec/functions.html
 *
 * \returns the jobject representing the instance of the Activity class of the
 *          Android application, or NULL on error.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_AndroidGetJNIEnv
 */
extern DECLSPEC void * SDLCALL SDL_AndroidGetActivity(void);

/**
 * Query Android API level of the current device.
 *
 * - API level 31: Android 12
 * - API level 30: Android 11
 * - API level 29: Android 10
 * - API level 28: Android 9
 * - API level 27: Android 8.1
 * - API level 26: Android 8.0
 * - API level 25: Android 7.1
 * - API level 24: Android 7.0
 * - API level 23: Android 6.0
 * - API level 22: Android 5.1
 * - API level 21: Android 5.0
 * - API level 20: Android 4.4W
 * - API level 19: Android 4.4
 * - API level 18: Android 4.3
 * - API level 17: Android 4.2
 * - API level 16: Android 4.1
 * - API level 15: Android 4.0.3
 * - API level 14: Android 4.0
 * - API level 13: Android 3.2
 * - API level 12: Android 3.1
 * - API level 11: Android 3.0
 * - API level 10: Android 2.3.3
 *
 * \returns the Android API level.
 *
 * \since This function is available since SDL 2.0.12.
 */
extern DECLSPEC int SDLCALL SDL_GetAndroidSDKVersion(void);

/**
 * Query if the application is running on Android TV.
 *
 * \returns SDL_TRUE if this is Android TV, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.8.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IsAndroidTV(void);

/**
 * Query if the application is running on a Chromebook.
 *
 * \returns SDL_TRUE if this is a Chromebook, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IsChromebook(void);

/**
 * Query if the application is running on a Samsung DeX docking station.
 *
 * \returns SDL_TRUE if this is a DeX docking station, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IsDeXMode(void);

/**
 * Trigger the Android system back button behavior.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC void SDLCALL SDL_AndroidBackButton(void);

/**
 * See the official Android developer guide for more information:
 * http://developer.android.com/guide/topics/data/data-storage.html
 */
#define SDL_ANDROID_EXTERNAL_STORAGE_READ   0x01
#define SDL_ANDROID_EXTERNAL_STORAGE_WRITE  0x02

/**
 * Get the path used for internal storage for this application.
 *
 * This path is unique to your application and cannot be written to by other
 * applications.
 *
 * Your internal storage path is typically:
 * `/data/data/your.app.package/files`.
 *
 * \returns the path used for internal storage or NULL on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_AndroidGetExternalStorageState
 */
extern DECLSPEC const char * SDLCALL SDL_AndroidGetInternalStoragePath(void);

/**
 * Get the current state of external storage.
 *
 * The current state of external storage, a bitmask of these values:
 * `SDL_ANDROID_EXTERNAL_STORAGE_READ`, `SDL_ANDROID_EXTERNAL_STORAGE_WRITE`.
 *
 * If external storage is currently unavailable, this will return 0.
 *
 * \returns the current state of external storage on success or 0 on failure;
 *          call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_AndroidGetExternalStoragePath
 */
extern DECLSPEC int SDLCALL SDL_AndroidGetExternalStorageState(void);

/**
 * Get the path used for external storage for this application.
 *
 * This path is unique to your application, but is public and can be written
 * to by other applications.
 *
 * Your external storage path is typically:
 * `/storage/sdcard0/Android/data/your.app.package/files`.
 *
 * \returns the path used for external storage for this application on success
 *          or NULL on failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_AndroidGetExternalStorageState
 */
extern DECLSPEC const char * SDLCALL SDL_AndroidGetExternalStoragePath(void);

/**
 * Request permissions at runtime.
 *
 * This blocks the calling thread until the permission is granted or denied.
 *
 * \param permission The permission to request.
 * \returns SDL_TRUE if the permission was granted, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.14.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_AndroidRequestPermission(const char *permission);

/**
 * Shows an Android toast notification.
 *
 * Toasts are a sort of lightweight notification that are unique to Android.
 *
 * https://developer.android.com/guide/topics/ui/notifiers/toasts
 *
 * Shows toast in UI thread.
 *
 * For the `gravity` parameter, choose a value from here, or -1 if you don't
 * have a preference:
 *
 * https://developer.android.com/reference/android/view/Gravity
 *
 * \param message text message to be shown.
 * \param duration 0=short, 1=long.
 * \param gravity where the notification should appear on the screen.
 * \param xoffset set this parameter only when gravity >=0.
 * \param yoffset set this parameter only when gravity >=0.
 * \returns 0 if success, -1 if any error occurs.
 *
 * \since This function is available since SDL 2.0.16.
 */
extern DECLSPEC int SDLCALL SDL_AndroidShowToast(const char* message, int duration, int gravity, int xoffset, int yoffset);

/**
 * Send a user command to SDLActivity.
 *
 * Override "boolean onUnhandledMessage(Message msg)" to handle the message.
 *
 * \param command user command that must be greater or equal to 0x8000.
 * \param param user parameter.
 *
 * \since This function is available since SDL 2.0.22.
 */
extern DECLSPEC int SDLCALL SDL_AndroidSendMessage(Uint32 command, int param);

#endif /* __ANDROID__ */

/* Platform specific functions for WinRT */
#ifdef __WINRT__

/**
 * WinRT / Windows Phone path types
 */
typedef enum SDL_WinRT_Path
{
    /** \brief The installed app's root directory.
        Files here are likely to be read-only. */
    SDL_WINRT_PATH_INSTALLED_LOCATION,

    /** \brief The app's local data store.  Files may be written here */
    SDL_WINRT_PATH_LOCAL_FOLDER,

    /** \brief The app's roaming data store.  Unsupported on Windows Phone.
        Files written here may be copied to other machines via a network
        connection.
    */
    SDL_WINRT_PATH_ROAMING_FOLDER,

    /** \brief The app's temporary data store.  Unsupported on Windows Phone.
        Files written here may be deleted at any time. */
    SDL_WINRT_PATH_TEMP_FOLDER
} SDL_WinRT_Path;


/**
 * WinRT Device Family
 */
typedef enum SDL_WinRT_DeviceFamily
{
    /** \brief Unknown family  */
    SDL_WINRT_DEVICEFAMILY_UNKNOWN,

    /** \brief Desktop family*/
    SDL_WINRT_DEVICEFAMILY_DESKTOP,

    /** \brief Mobile family (for example smartphone) */
    SDL_WINRT_DEVICEFAMILY_MOBILE,

    /** \brief XBox family */
    SDL_WINRT_DEVICEFAMILY_XBOX,
} SDL_WinRT_DeviceFamily;


/**
 * Retrieve a WinRT defined path on the local file system.
 *
 * Not all paths are available on all versions of Windows. This is especially
 * true on Windows Phone. Check the documentation for the given SDL_WinRT_Path
 * for more information on which path types are supported where.
 *
 * Documentation on most app-specific path types on WinRT can be found on
 * MSDN, at the URL:
 *
 * https://msdn.microsoft.com/en-us/library/windows/apps/hh464917.aspx
 *
 * \param pathType the type of path to retrieve, one of SDL_WinRT_Path.
 * \returns a UCS-2 string (16-bit, wide-char) containing the path, or NULL if
 *          the path is not available for any reason; call SDL_GetError() for
 *          more information.
 *
 * \since This function is available since SDL 2.0.3.
 *
 * \sa SDL_WinRTGetFSPathUTF8
 */
extern DECLSPEC const wchar_t * SDLCALL SDL_WinRTGetFSPathUNICODE(SDL_WinRT_Path pathType);

/**
 * Retrieve a WinRT defined path on the local file system.
 *
 * Not all paths are available on all versions of Windows. This is especially
 * true on Windows Phone. Check the documentation for the given SDL_WinRT_Path
 * for more information on which path types are supported where.
 *
 * Documentation on most app-specific path types on WinRT can be found on
 * MSDN, at the URL:
 *
 * https://msdn.microsoft.com/en-us/library/windows/apps/hh464917.aspx
 *
 * \param pathType the type of path to retrieve, one of SDL_WinRT_Path.
 * \returns a UTF-8 string (8-bit, multi-byte) containing the path, or NULL if
 *          the path is not available for any reason; call SDL_GetError() for
 *          more information.
 *
 * \since This function is available since SDL 2.0.3.
 *
 * \sa SDL_WinRTGetFSPathUNICODE
 */
extern DECLSPEC const char * SDLCALL SDL_WinRTGetFSPathUTF8(SDL_WinRT_Path pathType);

/**
 * Detects the device family of WinRT platform at runtime.
 *
 * \returns a value from the SDL_WinRT_DeviceFamily enum.
 *
 * \since This function is available since SDL 2.0.8.
 */
extern DECLSPEC SDL_WinRT_DeviceFamily SDLCALL SDL_WinRTGetDeviceFamily();

#endif /* __WINRT__ */

/**
 * Query if the current device is a tablet.
 *
 * If SDL can't determine this, it will return SDL_FALSE.
 *
 * \returns SDL_TRUE if the device is a tablet, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IsTablet(void);

/* Functions used by iOS application delegates to notify SDL about state changes */
extern DECLSPEC void SDLCALL SDL_OnApplicationWillTerminate(void);
extern DECLSPEC void SDLCALL SDL_OnApplicationDidReceiveMemoryWarning(void);
extern DECLSPEC void SDLCALL SDL_OnApplicationWillResignActive(void);
extern DECLSPEC void SDLCALL SDL_OnApplicationDidEnterBackground(void);
extern DECLSPEC void SDLCALL SDL_OnApplicationWillEnterForeground(void);
extern DECLSPEC void SDLCALL SDL_OnApplicationDidBecomeActive(void);
#ifdef __IPHONEOS__
extern DECLSPEC void SDLCALL SDL_OnApplicationDidChangeStatusBarOrientation(void);
#endif

/* Functions used only by GDK */
#if defined(__GDK__)
typedef struct XTaskQueueObject *XTaskQueueHandle;
typedef struct XUser *XUserHandle;

/**
 * Gets a reference to the global async task queue handle for GDK,
 * initializing if needed.
 *
 * Once you are done with the task queue, you should call
 * XTaskQueueCloseHandle to reduce the reference count to avoid a resource
 * leak.
 *
 * \param outTaskQueue a pointer to be filled in with task queue handle.
 * \returns 0 if success, -1 if any error occurs.
 *
 * \since This function is available since SDL 2.24.0.
 */
extern DECLSPEC int SDLCALL SDL_GDKGetTaskQueue(XTaskQueueHandle * outTaskQueue);

/**
 * Gets a reference to the default user handle for GDK.
 *
 * This is effectively a synchronous version of XUserAddAsync, which always
 * prefers the default user and allows a sign-in UI.
 *
 * \param outUserHandle a pointer to be filled in with the default user
 *                      handle.
 * \returns 0 if success, -1 if any error occurs.
 *
 * \since This function is available since SDL 2.28.0.
 */
extern DECLSPEC int SDLCALL SDL_GDKGetDefaultUser(XUserHandle * outUserHandle);

#endif

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_system_h_ */

/* vi: set ts=4 sw=4 expandtab: */
