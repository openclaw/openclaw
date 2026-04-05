/*
Date: Tue, 16 Mar 2004 19:38:40 -0800
From: Harold Levy <Harold.Levy@synopsys.com>
Subject: fgets(stdin) --> readline() redirector
To: chet@po.cwru.edu

Hi Chet,

Here is something you may find useful enough to include in the readline
distribution.  It is a shared library that redirects calls to fgets(stdin)
to readline() via LD_PRELOAD, and it supports a custom prompt and list of
command names.  Many people have asked me for this file, so I thought I'd
pass it your way in hope of just including it with readline to begin with.

Best Regards,

-Harold
*/

/******************************************************************************
*******************************************************************************
  
  FILE NAME:    fgets.c                  TARGET:   libfgets.so
  AUTHOR:       Harold Levy              VERSION:  1.0
                hlevy@synopsys.com
  
  ABSTRACT:  Customize fgets() behavior via LD_PRELOAD in the following ways:
  
    -- If fgets(stdin) is called, redirect to GNU readline() to obtain
       command-line editing, file-name completion, history, etc.
  
    -- A list of commands for command-name completion can be configured by
       setting the environment-variable FGETS_COMMAND_FILE to a file containing
       the list of commands to be used.
  
    -- Command-line editing with readline() works best when the prompt string
       is known; you can set this with the FGETS_PROMPT environment variable.
  
    -- There special strings that libfgets will interpret as internal commands:
  
           _fgets_reset_    reset the command list
  
           _fgets_dump_     dump status
  
           _fgets_debug_    toggle debug messages

  HOW TO BUILD:  Here are examples of how to build libfgets.so on various
  platforms; you will have to add -I and -L flags to configure access to
  the readline header and library files.

  (32-bit builds with gcc)
  AIX:   gcc -fPIC fgets.c -shared -o libfgets.so -lc -ldl -lreadline -ltermcap
  HP-UX: gcc -fPIC fgets.c -shared -o libfgets.so -lc -ldld -lreadline
  Linux: gcc -fPIC fgets.c -shared -o libfgets.so -lc -ldl -lreadline
  SunOS: gcc -fPIC fgets.c -shared -o libfgets.so -lc -ldl -lgen -lreadline

  (64-bit builds without gcc)
  SunOS: SUNWspro/bin/cc -D_LARGEFILE64_SOURCE=1 -xtarget=ultra -xarch=v9 \
           -KPIC fgets.c -Bdynamic -lc -ldl -lgen -ltermcap -lreadline
  
  HOW TO USE:  Different operating systems have different levels of support
  for the LD_PRELOAD concept.  The generic method for 32-bit platforms is to
  put libtermcap.so, libfgets.so, and libreadline.so (with absolute paths)
  in the LD_PRELOAD environment variable, and to put their parent directories
  in the LD_LIBRARY_PATH environment variable.  Unfortunately there is no
  generic method for 64-bit platforms; e.g. for 64-bit SunOS, you would have
  to build both 32-bit and 64-bit libfgets and libreadline libraries, and
  use the LD_FLAGS_32 and LD_FLAGS_64 environment variables with preload and
  library_path configurations (a mix of 32-bit and 64-bit calls are made under
  64-bit SunOS).
  
  EXAMPLE WRAPPER:  Here is an example shell script wrapper around the
  program "foo" that uses fgets() for command-line input:

      #!/bin/csh
      #### replace this with the libtermcap.so directory:
      set dir1 = "/usr/lib"
      #### replace this with the libfgets.so directory:
      set dir2 = "/usr/fgets"
      #### replace this with the libreadline.so directory:
      set dir3 = "/usr/local/lib"
      set lib1 = "${dir1}/libtermcap.so"
      set lib2 = "${dir2}/libfgets.so"
      set lib3 = "${dir3}/libreadline.so"
      if ( "${?LD_PRELOAD}" ) then
        setenv LD_PRELOAD "${lib1}:${lib2}:${lib3}:${LD_PRELOAD}"
      else
        setenv LD_PRELOAD "${lib1}:${lib2}:${lib3}"
      endif
      if ( "${?LD_LIBRARY_PATH}" ) then
        setenv LD_LIBRARY_PATH "${dir1}:${dir2}:${dir3}:${LD_LIBRARY_PATH}"
      else
        setenv LD_LIBRARY_PATH "${dir1}:${dir2}:${dir3}"
      endif
      setenv FGETS_COMMAND_FILE "${dir2}/foo.commands"
      setenv FGETS_PROMPT       "foo> "
      exec "foo" $*
  
  Copyright (C)©2003-2004 Harold Levy.
  
  This code links to the GNU readline library, and as such is bound by the
  terms of the GNU General Public License as published by the Free Software
  Foundation, either version 2 or (at your option) any later version.
  
  The GNU General Public License is often shipped with GNU software, and is
  generally kept in a file called COPYING or LICENSE.  If you do not have a
  copy of the license, write to the Free Software Foundation, 59 Temple Place,
  Suite 330, Boston, MA 02111 USA.
  
  This program is distributed in the hope that it will be useful, but WITHOUT
  ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
  FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more
  details.
  
*******************************************************************************
******************************************************************************/



#include <dlfcn.h>
#include <stdio.h>
#include <strings.h>
#include <stdlib.h>
#include <unistd.h>

#include <readline/readline.h>
#include <readline/history.h>



/* for dynamically connecting to the native fgets() */
#if defined(RTLD_NEXT)
#define REAL_LIBC RTLD_NEXT
#else
#define REAL_LIBC ((void *) -1L)
#endif
typedef char * ( * fgets_t ) ( char * s, int n, FILE * stream ) ;



/* private data */
/* -- writeable data is stored in the shared library's data segment
   -- every process that uses the shared library gets a private memory copy of
      its entire data segment
   -- static data in the shared library is not copied to the application
   -- only read-only (i.e. 'const') data is stored in the shared library's
      text segment
*/
static char ** my_fgets_names           = NULL ;
static int     my_fgets_number_of_names = 0    ;
static int     my_fgets_debug_flag      = 0    ;



/* invoked with _fgets_reset_ */
static void
my_fgets_reset (
  void
) {
  if ( my_fgets_names && (my_fgets_number_of_names > 0) ) {
    int i ;
    if ( my_fgets_debug_flag ) {
      printf ( "libfgets:  removing command list\n" ) ;
    }
    for ( i = 0 ; i < my_fgets_number_of_names ; i ++ ) {
      if ( my_fgets_names[i] ) free ( my_fgets_names[i] ) ;
    }
    free ( my_fgets_names ) ;
  }
  my_fgets_names = NULL ;
  my_fgets_number_of_names = 0 ;
}



/* invoked with _fgets_dump_ */
static void
my_fgets_dump (
  void
) {
  char * s ;
  printf ( "\n" ) ;
  s = getenv ( "FGETS_PROMPT" ) ;
  printf ( "FGETS_PROMPT       = %s\n", s ? s : "" ) ;
  s = getenv ( "FGETS_COMMAND_FILE" ) ;
  printf ( "FGETS_COMMAND_FILE = %s\n", s ? s : "" ) ;
  printf ( "debug flag         = %d\n", my_fgets_debug_flag ) ;
  printf ( "#commands          = %d\n", my_fgets_number_of_names ) ;
  if ( my_fgets_debug_flag ) {
    if ( my_fgets_names && (my_fgets_number_of_names > 0) ) {
      int i ;
      for ( i = 0 ; i < my_fgets_number_of_names ; i ++ ) {
        printf ( "%s\n", my_fgets_names[i] ) ;
      }
    }
  }
  printf ( "\n" ) ;
}



/* invoked with _fgets_debug_ */
static void
my_fgets_debug_toggle (
  void
) {
  my_fgets_debug_flag = my_fgets_debug_flag ? 0 : 1 ;
  if ( my_fgets_debug_flag ) {
    printf ( "libfgets:  debug flag = %d\n", my_fgets_debug_flag ) ;
  }
}



/* read the command list if needed, return the i-th name */
static char *
my_fgets_lookup (
  int index
) {
  if ( (! my_fgets_names) || (! my_fgets_number_of_names) ) {
    char * fname ;
    FILE * fp ;
    fgets_t _fgets ;
    int i ;
    char buf1[256], buf2[256] ;
    fname = getenv ( "FGETS_COMMAND_FILE" ) ;
    if ( ! fname ) {
      if ( my_fgets_debug_flag ) {
        printf ( "libfgets:  empty or unset FGETS_COMMAND_FILE\n" ) ;
      }
      return NULL ;
    }
    fp = fopen ( fname, "r" ) ;
    if ( ! fp ) {
      if ( my_fgets_debug_flag ) {
        printf ( "libfgets:  cannot open '%s' for reading\n", fname ) ;
      }
      return NULL ;
    }
    _fgets = (fgets_t) dlsym ( REAL_LIBC, "fgets" ) ;
    if ( ! _fgets ) {
      fprintf ( stderr,
        "libfgets:  failed to dynamically link to native fgets()\n"
      ) ;
      return NULL ;
    }
    for ( i = 0 ; _fgets(buf1,255,fp) ; i ++ ) ;
    if ( ! i ) { fclose(fp) ; return NULL ; }
    my_fgets_names = (char**) calloc ( i, sizeof(char*) ) ;
    rewind ( fp ) ;
    i = 0 ;
    while ( _fgets(buf1,255,fp) ) {
      buf1[255] = 0 ;
      if ( 1 == sscanf(buf1,"%s",buf2) ) {
        my_fgets_names[i] = strdup(buf2) ;
        i ++ ;
      }
    }
    fclose ( fp ) ;
    my_fgets_number_of_names = i ;
    if ( my_fgets_debug_flag ) {
      printf ( "libfgets:  successfully read %d commands\n", i ) ;
    }
  }
  if ( index < my_fgets_number_of_names ) {
    return my_fgets_names[index] ;
  } else {
    return NULL ;
  }
}



/* generate a list of partial name matches for readline() */
static char *
my_fgets_generator (
  const char * text,
  int          state
)
{
  static int list_index, len ;
  char *     name ;
  if ( ! state ) {
    list_index = 0 ;
    len = strlen ( text ) ;
  }
  while ( ( name = my_fgets_lookup(list_index) ) ) {
    list_index ++ ;
    if ( ! strncmp ( name, text, len ) ) {
      return ( strdup ( name ) ) ;
    }
  }
  return ( NULL ) ;
}



/* partial name completion callback for readline() */
static char **
my_fgets_completion (
  const char * text,
  int          start,
  int          end
)
{
  char ** matches ;
  matches = NULL ;
  if ( ! start ) {
    matches = rl_completion_matches ( text, my_fgets_generator ) ;
  }
  return ( matches ) ;
}



/* fgets() intercept */
char *
fgets (
  char * s,
  int    n,
  FILE * stream
)
{
  if ( ! s ) return NULL ;
  if ( stream == stdin ) {
    char * prompt ;
    char * my_fgets_line ;
    rl_already_prompted = 1 ;
    rl_attempted_completion_function = my_fgets_completion ;
    rl_catch_signals = 1 ;
    rl_catch_sigwinch = 1 ;
    rl_set_signals () ;
    prompt = getenv ( "FGETS_PROMPT" ) ;
    for (
      my_fgets_line = 0 ; ! my_fgets_line ; my_fgets_line=readline(prompt)
    ) ;
    if ( ! strncmp(my_fgets_line, "_fgets_reset_", 13) ) {
      my_fgets_reset () ;
      free ( my_fgets_line ) ;
      strcpy ( s, "\n" ) ;
      return ( s ) ;
    }
    if ( ! strncmp(my_fgets_line, "_fgets_dump_", 12) ) {
      my_fgets_dump () ;
      free ( my_fgets_line ) ;
      strcpy ( s, "\n" ) ;
      return ( s ) ;
    }
    if ( ! strncmp(my_fgets_line, "_fgets_debug_", 13) ) {
      my_fgets_debug_toggle () ;
      free ( my_fgets_line ) ;
      strcpy ( s, "\n" ) ;
      return ( s ) ;
    }
    (void) strncpy ( s, my_fgets_line, n-1 ) ;
    (void) strcat ( s, "\n" ) ;
    if ( *my_fgets_line ) add_history ( my_fgets_line ) ;
    free ( my_fgets_line ) ;
    return ( s ) ;
  } else {
    static fgets_t _fgets ;
    _fgets = (fgets_t) dlsym ( REAL_LIBC, "fgets" ) ;
    if ( ! _fgets ) {
      fprintf ( stderr,
        "libfgets:  failed to dynamically link to native fgets()\n"
      ) ;
      strcpy ( s, "\n" ) ;
      return ( s ) ;
    }
    return (
      _fgets ( s, n, stream )
    ) ;
  }
}
