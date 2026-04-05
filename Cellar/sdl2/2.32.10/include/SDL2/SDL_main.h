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

#ifndef SDL_main_h_
#define SDL_main_h_

#include "SDL_stdinc.h"

/**
 * # CategoryMain
 *
 * Redefine main() on some platforms so that it is called by SDL.
 */

#ifndef SDL_MAIN_HANDLED
#if defined(__WIN32__)
/* On Windows SDL provides WinMain(), which parses the command line and passes
   the arguments to your main function.

   If you provide your own WinMain(), you may define SDL_MAIN_HANDLED
 */
#define SDL_MAIN_AVAILABLE

#elif defined(__WINRT__)
/* On WinRT, SDL provides a main function that initializes CoreApplication,
   creating an instance of IFrameworkView in the process.

   Please note that #include'ing SDL_main.h is not enough to get a main()
   function working.  In non-XAML apps, the file,
   src/main/winrt/SDL_WinRT_main_NonXAML.cpp, or a copy of it, must be compiled
   into the app itself.  In XAML apps, the function, SDL_WinRTRunApp must be
   called, with a pointer to the Direct3D-hosted XAML control passed in.
*/
#define SDL_MAIN_NEEDED

#elif defined(__GDK__)
/* On GDK, SDL provides a main function that initializes the game runtime.

   Please note that #include'ing SDL_main.h is not enough to get a main()
   function working. You must either link against SDL2main or, if not possible,
   call the SDL_GDKRunApp function from your entry point.
*/
#define SDL_MAIN_NEEDED

#elif defined(__IPHONEOS__)
/* On iOS SDL provides a main function that creates an application delegate
   and starts the iOS application run loop.

   If you link with SDL dynamically on iOS, the main function can't be in a
   shared library, so you need to link with libSDLmain.a, which includes a
   stub main function that calls into the shared library to start execution.

   See src/video/uikit/SDL_uikitappdelegate.m for more details.
 */
#define SDL_MAIN_NEEDED

#elif defined(__ANDROID__)
/* On Android SDL provides a Java class in SDLActivity.java that is the
   main activity entry point.

   See docs/README-android.md for more details on extending that class.
 */
#define SDL_MAIN_NEEDED

/* We need to export SDL_main so it can be launched from Java */
#define SDLMAIN_DECLSPEC    DECLSPEC

#elif defined(__NACL__)
/* On NACL we use ppapi_simple to set up the application helper code,
   then wait for the first PSE_INSTANCE_DIDCHANGEVIEW event before 
   starting the user main function.
   All user code is run in a separate thread by ppapi_simple, thus 
   allowing for blocking io to take place via nacl_io
*/
#define SDL_MAIN_NEEDED

#elif defined(__PSP__)
/* On PSP SDL provides a main function that sets the module info,
   activates the GPU and starts the thread required to be able to exit
   the software.

   If you provide this yourself, you may define SDL_MAIN_HANDLED
 */
#define SDL_MAIN_AVAILABLE

#elif defined(__PS2__)
#define SDL_MAIN_AVAILABLE

#define SDL_PS2_SKIP_IOP_RESET() \
   void reset_IOP(); \
   void reset_IOP() {}

#elif defined(__3DS__)
/*
  On N3DS, SDL provides a main function that sets up the screens
  and storage.

  If you provide this yourself, you may define SDL_MAIN_HANDLED
*/
#define SDL_MAIN_AVAILABLE

#endif
#endif /* SDL_MAIN_HANDLED */

#ifndef SDLMAIN_DECLSPEC
#define SDLMAIN_DECLSPEC
#endif

/**
 *  \file SDL_main.h
 *
 *  The application's main() function must be called with C linkage,
 *  and should be declared like this:
 *  ```c
 *  #ifdef __cplusplus
 *  extern "C"
 *  #endif
 *  int main(int argc, char *argv[])
 *  {
 *  }
 *  ```
 */

#if defined(SDL_MAIN_NEEDED) || defined(SDL_MAIN_AVAILABLE)
#define main    SDL_main
#endif

#include "begin_code.h"
#ifdef __cplusplus
extern "C" {
#endif

/**
 * The prototype for the application's main() function
 */
typedef int (*SDL_main_func)(int argc, char *argv[]);
extern SDLMAIN_DECLSPEC int SDL_main(int argc, char *argv[]);


/**
 * Circumvent failure of SDL_Init() when not using SDL_main() as an entry
 * point.
 *
 * This function is defined in SDL_main.h, along with the preprocessor rule to
 * redefine main() as SDL_main(). Thus to ensure that your main() function
 * will not be changed it is necessary to define SDL_MAIN_HANDLED before
 * including SDL.h.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_Init
 */
extern DECLSPEC void SDLCALL SDL_SetMainReady(void);

#if defined(__WIN32__) || defined(__GDK__)

/**
 * Register a win32 window class for SDL's use.
 *
 * This can be called to set the application window class at startup. It is
 * safe to call this multiple times, as long as every call is eventually
 * paired with a call to SDL_UnregisterApp, but a second registration attempt
 * while a previous registration is still active will be ignored, other than
 * to increment a counter.
 *
 * Most applications do not need to, and should not, call this directly; SDL
 * will call it when initializing the video subsystem.
 *
 * \param name the window class name, in UTF-8 encoding. If NULL, SDL
 *             currently uses "SDL_app" but this isn't guaranteed.
 * \param style the value to use in WNDCLASSEX::style. If `name` is NULL, SDL
 *              currently uses `(CS_BYTEALIGNCLIENT | CS_OWNDC)` regardless of
 *              what is specified here.
 * \param hInst the HINSTANCE to use in WNDCLASSEX::hInstance. If zero, SDL
 *              will use `GetModuleHandle(NULL)` instead.
 * \returns 0 on success, -1 on error. SDL_GetError() may have details.
 *
 * \since This function is available since SDL 2.0.2.
 */
extern DECLSPEC int SDLCALL SDL_RegisterApp(const char *name, Uint32 style, void *hInst);

/**
 * Deregister the win32 window class from an SDL_RegisterApp call.
 *
 * This can be called to undo the effects of SDL_RegisterApp.
 *
 * Most applications do not need to, and should not, call this directly; SDL
 * will call it when deinitializing the video subsystem.
 *
 * It is safe to call this multiple times, as long as every call is eventually
 * paired with a prior call to SDL_RegisterApp. The window class will only be
 * deregistered when the registration counter in SDL_RegisterApp decrements to
 * zero through calls to this function.
 *
 * \since This function is available since SDL 2.0.2.
 */
extern DECLSPEC void SDLCALL SDL_UnregisterApp(void);

#endif /* defined(__WIN32__) || defined(__GDK__) */


#ifdef __WINRT__

/**
 * Initialize and launch an SDL/WinRT application.
 *
 * \param mainFunction the SDL app's C-style main(), an SDL_main_func.
 * \param reserved reserved for future use; should be NULL.
 * \returns 0 on success or -1 on failure; call SDL_GetError() to retrieve
 *          more information on the failure.
 *
 * \since This function is available since SDL 2.0.3.
 */
extern DECLSPEC int SDLCALL SDL_WinRTRunApp(SDL_main_func mainFunction, void * reserved);

#endif /* __WINRT__ */

#if defined(__IPHONEOS__)

/**
 * Initializes and launches an SDL application.
 *
 * \param argc The argc parameter from the application's main() function.
 * \param argv The argv parameter from the application's main() function.
 * \param mainFunction The SDL app's C-style main(), an SDL_main_func.
 * \return the return value from mainFunction.
 *
 * \since This function is available since SDL 2.0.10.
 */
extern DECLSPEC int SDLCALL SDL_UIKitRunApp(int argc, char *argv[], SDL_main_func mainFunction);

#endif /* __IPHONEOS__ */

#ifdef __GDK__

/**
 * Initialize and launch an SDL GDK application.
 *
 * \param mainFunction the SDL app's C-style main(), an SDL_main_func.
 * \param reserved reserved for future use; should be NULL.
 * \returns 0 on success or -1 on failure; call SDL_GetError() to retrieve
 *          more information on the failure.
 *
 * \since This function is available since SDL 2.24.0.
 */
extern DECLSPEC int SDLCALL SDL_GDKRunApp(SDL_main_func mainFunction, void *reserved);

/**
 * Callback from the application to let the suspend continue.
 *
 * \since This function is available since SDL 2.28.0.
 */
extern DECLSPEC void SDLCALL SDL_GDKSuspendComplete(void);

#endif /* __GDK__ */

#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_main_h_ */

/* vi: set ts=4 sw=4 expandtab: */
