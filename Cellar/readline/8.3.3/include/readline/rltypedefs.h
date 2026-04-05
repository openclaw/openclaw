/* rltypedefs.h -- Type declarations for readline functions. */

/* Copyright (C) 2000-2023 Free Software Foundation, Inc.

   This file is part of the GNU Readline Library (Readline), a library
   for reading lines of text with interactive input and history editing.      

   Readline is free software: you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published by
   the Free Software Foundation, either version 3 of the License, or
   (at your option) any later version.

   Readline is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with Readline.  If not, see <http://www.gnu.org/licenses/>.
*/

#ifndef _RL_TYPEDEFS_H_
#define _RL_TYPEDEFS_H_

#ifdef __cplusplus
extern "C" {
#endif

/* Old-style, attempt to mark as deprecated in some way people will notice. */

#if !defined (_FUNCTION_DEF) && defined (WANT_OBSOLETE_TYPEDEFS)
#  define _FUNCTION_DEF

typedef int Function () __attribute__((deprecated));
typedef void VFunction () __attribute__((deprecated));
typedef char *CPFunction () __attribute__((deprecated));
typedef char **CPPFunction () __attribute__((deprecated));

#endif /* _FUNCTION_DEF && WANT_OBSOLETE_TYPEDEFS */

/* New style. */

#if !defined (_RL_FUNCTION_TYPEDEF)
#  define _RL_FUNCTION_TYPEDEF

/* Bindable functions */
typedef int rl_command_func_t (int, int);

/* Typedefs for the completion system */
typedef char *rl_compentry_func_t (const char *, int);
typedef char **rl_completion_func_t (const char *, int, int);

typedef char *rl_quote_func_t (char *, int, char *);
typedef char *rl_dequote_func_t (char *, int);

typedef int rl_compignore_func_t (char **);

typedef void rl_compdisp_func_t (char **, int, int);

/* Functions for displaying key bindings. Currently only one. */
typedef void rl_macro_print_func_t (const char *, const char *, int, const char *);

/* Type for input and pre-read hook functions like rl_event_hook */
typedef int rl_hook_func_t (void);

/* Input function type */
typedef int rl_getc_func_t (FILE *);

/* Generic function that takes a character buffer (which could be the readline
   line buffer) and an index into it (which could be rl_point) and returns
   an int. */
typedef int rl_linebuf_func_t (char *, int);

/* `Generic' function pointer typedefs */
typedef int rl_intfunc_t (int);
#define rl_ivoidfunc_t rl_hook_func_t
typedef int rl_icpfunc_t (char *);
typedef int rl_icppfunc_t (char **);

typedef void rl_voidfunc_t (void);
typedef void rl_vintfunc_t (int);
typedef void rl_vcpfunc_t (char *);
typedef void rl_vcppfunc_t (char **);

typedef char *rl_cpvfunc_t (void);
typedef char *rl_cpifunc_t (int);
typedef char *rl_cpcpfunc_t (char  *);
typedef char *rl_cpcppfunc_t (char  **);

#endif /* _RL_FUNCTION_TYPEDEF */

#ifdef __cplusplus
}
#endif

#endif /* _RL_TYPEDEFS_H_ */
