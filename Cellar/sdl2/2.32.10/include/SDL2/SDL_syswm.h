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

/* WIKI CATEGORY: SYSWM */

/*
 * # CategorySYSWM
 *
 * Include file for SDL custom system window manager hooks.
 *
 * Your application has access to a special type of event SDL_SYSWMEVENT,
 * which contains window-manager specific information and arrives whenever
 * an unhandled window event occurs.  This event is ignored by default, but
 * you can enable it with SDL_EventState().
 */

#ifndef SDL_syswm_h_
#define SDL_syswm_h_

#include "SDL_stdinc.h"
#include "SDL_error.h"
#include "SDL_video.h"
#include "SDL_version.h"

struct SDL_SysWMinfo;

#if !defined(SDL_PROTOTYPES_ONLY)

#if defined(SDL_VIDEO_DRIVER_WINDOWS)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX   /* don't define min() and max(). */
#define NOMINMAX
#endif
#include <windows.h>
#endif

#if defined(SDL_VIDEO_DRIVER_WINRT)
#include <Inspectable.h>
#endif

/* This is the structure for custom window manager events */
#if defined(SDL_VIDEO_DRIVER_X11)
#if defined(__APPLE__) && defined(__MACH__)
/* conflicts with Quickdraw.h */
#define Cursor X11Cursor
#endif

#include <X11/Xlib.h>
#include <X11/Xatom.h>

#if defined(__APPLE__) && defined(__MACH__)
/* matches the re-define above */
#undef Cursor
#endif

#endif /* defined(SDL_VIDEO_DRIVER_X11) */

#if defined(SDL_VIDEO_DRIVER_DIRECTFB)
#include <directfb.h>
#endif

#if defined(SDL_VIDEO_DRIVER_COCOA)
#ifdef __OBJC__
@class NSWindow;
#else
typedef struct _NSWindow NSWindow;
#endif
#endif

#if defined(SDL_VIDEO_DRIVER_UIKIT)
#ifdef __OBJC__
#include <UIKit/UIKit.h>
#else
typedef struct _UIWindow UIWindow;
typedef struct _UIViewController UIViewController;
#endif
typedef Uint32 GLuint;
#endif

#if defined(SDL_VIDEO_VULKAN) || defined(SDL_VIDEO_METAL)
#define SDL_METALVIEW_TAG 255
#endif

#if defined(SDL_VIDEO_DRIVER_ANDROID)
typedef struct ANativeWindow ANativeWindow;
typedef void *EGLSurface;
#endif

#if defined(SDL_VIDEO_DRIVER_VIVANTE)
#include "SDL_egl.h"
#endif

#if defined(SDL_VIDEO_DRIVER_OS2)
#define INCL_WIN
#include <os2.h>
#endif
#endif /* SDL_PROTOTYPES_ONLY */

#if defined(SDL_VIDEO_DRIVER_KMSDRM)
struct gbm_device;
#endif


#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

#if !defined(SDL_PROTOTYPES_ONLY)

/**
 * These are the various supported windowing subsystems
 */
typedef enum SDL_SYSWM_TYPE
{
    SDL_SYSWM_UNKNOWN,
    SDL_SYSWM_WINDOWS,
    SDL_SYSWM_X11,
    SDL_SYSWM_DIRECTFB,
    SDL_SYSWM_COCOA,
    SDL_SYSWM_UIKIT,
    SDL_SYSWM_WAYLAND,
    SDL_SYSWM_MIR,  /* no longer available, left for API/ABI compatibility. Remove in 2.1! */
    SDL_SYSWM_WINRT,
    SDL_SYSWM_ANDROID,
    SDL_SYSWM_VIVANTE,
    SDL_SYSWM_OS2,
    SDL_SYSWM_HAIKU,
    SDL_SYSWM_KMSDRM,
    SDL_SYSWM_RISCOS
} SDL_SYSWM_TYPE;

/**
 * The custom event structure.
 */
struct SDL_SysWMmsg
{
    SDL_version version;
    SDL_SYSWM_TYPE subsystem;
    union
    {
#if defined(SDL_VIDEO_DRIVER_WINDOWS)
        struct {
            HWND hwnd;                  /**< The window for the message */
            UINT msg;                   /**< The type of message */
            WPARAM wParam;              /**< WORD message parameter */
            LPARAM lParam;              /**< LONG message parameter */
        } win;
#endif
#if defined(SDL_VIDEO_DRIVER_X11)
        struct {
            XEvent event;
        } x11;
#endif
#if defined(SDL_VIDEO_DRIVER_DIRECTFB)
        struct {
            DFBEvent event;
        } dfb;
#endif
#if defined(SDL_VIDEO_DRIVER_COCOA)
        struct
        {
            /* Latest version of Xcode clang complains about empty structs in C v. C++:
                 error: empty struct has size 0 in C, size 1 in C++
             */
            int dummy;
            /* No Cocoa window events yet */
        } cocoa;
#endif
#if defined(SDL_VIDEO_DRIVER_UIKIT)
        struct
        {
            int dummy;
            /* No UIKit window events yet */
        } uikit;
#endif
#if defined(SDL_VIDEO_DRIVER_VIVANTE)
        struct
        {
            int dummy;
            /* No Vivante window events yet */
        } vivante;
#endif
#if defined(SDL_VIDEO_DRIVER_OS2)
        struct
        {
            BOOL fFrame;                /**< TRUE if hwnd is a frame window */
            HWND hwnd;                  /**< The window receiving the message */
            ULONG msg;                  /**< The message identifier */
            MPARAM mp1;                 /**< The first first message parameter */
            MPARAM mp2;                 /**< The second first message parameter */
        } os2;
#endif
        /* Can't have an empty union */
        int dummy;
    } msg;
};

/**
 * The custom window manager information structure.
 *
 * When this structure is returned, it holds information about which low level
 * system it is using, and will be one of SDL_SYSWM_TYPE.
 */
struct SDL_SysWMinfo
{
    SDL_version version;
    SDL_SYSWM_TYPE subsystem;
    union
    {
#if defined(SDL_VIDEO_DRIVER_WINDOWS)
        struct
        {
            HWND window;                /**< The window handle */
            HDC hdc;                    /**< The window device context */
            HINSTANCE hinstance;        /**< The instance handle */
        } win;
#endif
#if defined(SDL_VIDEO_DRIVER_WINRT)
        struct
        {
            IInspectable * window;      /**< The WinRT CoreWindow */
        } winrt;
#endif
#if defined(SDL_VIDEO_DRIVER_X11)
        struct
        {
            Display *display;           /**< The X11 display */
            Window window;              /**< The X11 window */
        } x11;
#endif
#if defined(SDL_VIDEO_DRIVER_DIRECTFB)
        struct
        {
            IDirectFB *dfb;             /**< The directfb main interface */
            IDirectFBWindow *window;    /**< The directfb window handle */
            IDirectFBSurface *surface;  /**< The directfb client surface */
        } dfb;
#endif
#if defined(SDL_VIDEO_DRIVER_COCOA)
        struct
        {
#if defined(__OBJC__) && defined(__has_feature)
        #if __has_feature(objc_arc)
            NSWindow __unsafe_unretained *window; /**< The Cocoa window */
        #else
            NSWindow *window;                     /**< The Cocoa window */
        #endif
#else
            NSWindow *window;                     /**< The Cocoa window */
#endif
        } cocoa;
#endif
#if defined(SDL_VIDEO_DRIVER_UIKIT)
        struct
        {
#if defined(__OBJC__) && defined(__has_feature)
        #if __has_feature(objc_arc)
            UIWindow __unsafe_unretained *window; /**< The UIKit window */
        #else
            UIWindow *window;                     /**< The UIKit window */
        #endif
#else
            UIWindow *window;                     /**< The UIKit window */
#endif
            GLuint framebuffer; /**< The GL view's Framebuffer Object. It must be bound when rendering to the screen using GL. */
            GLuint colorbuffer; /**< The GL view's color Renderbuffer Object. It must be bound when SDL_GL_SwapWindow is called. */
            GLuint resolveFramebuffer; /**< The Framebuffer Object which holds the resolve color Renderbuffer, when MSAA is used. */
        } uikit;
#endif
#if defined(SDL_VIDEO_DRIVER_WAYLAND)
        struct
        {
            struct wl_display *display;             /**< Wayland display */
            struct wl_surface *surface;             /**< Wayland surface */
            void *shell_surface;                    /**< DEPRECATED Wayland shell_surface (window manager handle) */
            struct wl_egl_window *egl_window;       /**< Wayland EGL window (native window) */
            struct xdg_surface *xdg_surface;        /**< Wayland xdg surface (window manager handle) */
            struct xdg_toplevel *xdg_toplevel;      /**< Wayland xdg toplevel role */
            struct xdg_popup *xdg_popup;            /**< Wayland xdg popup role */
            struct xdg_positioner *xdg_positioner;  /**< Wayland xdg positioner, for popup */
        } wl;
#endif
#if defined(SDL_VIDEO_DRIVER_MIR)  /* no longer available, left for API/ABI compatibility. Remove in 2.1! */
        struct
        {
            void *connection;  /**< Mir display server connection */
            void *surface;  /**< Mir surface */
        } mir;
#endif

#if defined(SDL_VIDEO_DRIVER_ANDROID)
        struct
        {
            ANativeWindow *window;
            EGLSurface surface;
        } android;
#endif

#if defined(SDL_VIDEO_DRIVER_OS2)
        struct
        {
            HWND hwnd;                  /**< The window handle */
            HWND hwndFrame;             /**< The frame window handle */
        } os2;
#endif

#if defined(SDL_VIDEO_DRIVER_VIVANTE)
        struct
        {
            EGLNativeDisplayType display;
            EGLNativeWindowType window;
        } vivante;
#endif

#if defined(SDL_VIDEO_DRIVER_KMSDRM)
        struct
        {
            int dev_index;               /**< Device index (ex: the X in /dev/dri/cardX) */
            int drm_fd;                  /**< DRM FD (unavailable on Vulkan windows) */
            struct gbm_device *gbm_dev;  /**< GBM device (unavailable on Vulkan windows) */
        } kmsdrm;
#endif

        /* Make sure this union is always 64 bytes (8 64-bit pointers). */
        /* Be careful not to overflow this if you add a new target! */
        Uint8 dummy[64];
    } info;
};

#endif /* SDL_PROTOTYPES_ONLY */

typedef struct SDL_SysWMinfo SDL_SysWMinfo;


/**
 * Get driver-specific information about a window.
 *
 * You must include SDL_syswm.h for the declaration of SDL_SysWMinfo.
 *
 * The caller must initialize the `info` structure's version by using
 * `SDL_VERSION(&info.version)`, and then this function will fill in the rest
 * of the structure with information about the given window.
 *
 * \param window the window about which information is being requested.
 * \param info an SDL_SysWMinfo structure filled in with window information.
 * \returns SDL_TRUE if the function is implemented and the `version` member
 *          of the `info` struct is valid, or SDL_FALSE if the information
 *          could not be retrieved; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_GetWindowWMInfo(SDL_Window * window,
                                                     SDL_SysWMinfo * info);


/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_syswm_h_ */

/* vi: set ts=4 sw=4 expandtab: */
