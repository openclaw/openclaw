/*
 * rl - command-line interface to read a line from the standard input
 *      (or another fd) using readline.
 *
 * usage: rl [-p prompt] [-u unit] [-d default] [-n nchars]
 */

/* Copyright (C) 1987-2023 Free Software Foundation, Inc.

   This file is part of the GNU Readline Library (Readline), a library for
   reading lines of text with interactive input and history editing.

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

#if defined (HAVE_CONFIG_H)
#  include <config.h>
#endif

#include <unistd.h>
#include <stdio.h>
#include <sys/types.h>

#ifdef HAVE_STDLIB_H
#  include <stdlib.h>
#else 
extern void exit();
#endif

#ifdef HAVE_LOCALE_H
#  include <locale.h>
#endif

#if defined (READLINE_LIBRARY)
#  include "posixstat.h"
#  include "readline.h"
#  include "history.h"
#else
#  include <sys/stat.h>
#  include <readline/readline.h>
#  include <readline/history.h>
#endif

extern int optind;
extern char *optarg;

static char *progname;
static char *deftext;

static int
set_deftext (void)
{
  if (deftext)
    {
      rl_insert_text (deftext);
      deftext = (char *)NULL;
      rl_startup_hook = (rl_hook_func_t *)NULL;
    }
  return 0;
}

static void
usage(void)
{
  fprintf (stderr, "%s: usage: %s [-p prompt] [-u unit] [-d default] [-n nchars]\n",
		progname, progname);
}

int
main (int argc, char **argv)
{
  char *temp, *prompt;
  struct stat sb;
  int opt, fd, nch;
  FILE *ifp;

  progname = strrchr(argv[0], '/');
  if (progname == 0)
    progname = argv[0];
  else
    progname++;

#ifdef HAVE_SETLOCALE
  setlocale (LC_ALL, "");
#endif

  /* defaults */
  prompt = "readline$ ";
  fd = nch = 0;
  deftext = (char *)0;

  while ((opt = getopt(argc, argv, "p:u:d:n:")) != EOF)
    {
      switch (opt)
	{
	case 'p':
	  prompt = optarg;
	  break;
	case 'u':
	  fd = atoi(optarg);
	  if (fd < 0)
	    {
	      fprintf (stderr, "%s: bad file descriptor `%s'\n", progname, optarg);
	      exit (2);
	    }
	  break;
	case 'd':
	  deftext = optarg;
	  break;
	case 'n':
	  nch = atoi(optarg);
	  if (nch < 0)
	    {
	      fprintf (stderr, "%s: bad value for -n: `%s'\n", progname, optarg);
	      exit (2);
	    }
	  break;
	default:
	  usage ();
	  exit (2);
	}
    }

  if (fd != 0)
    {
      if (fstat (fd, &sb) < 0)
	{
	  fprintf (stderr, "%s: %d: bad file descriptor\n", progname, fd);
	  exit (1);
	}
      ifp = fdopen (fd, "r");
      rl_instream = ifp;
    }

  if (deftext && *deftext)
    rl_startup_hook = set_deftext;

  if (nch > 0)
    rl_num_chars_to_read = nch;

  temp = readline (prompt);

  /* Test for EOF. */
  if (temp == 0)
    exit (1);

  printf ("%s\n", temp);
  exit (0);
}
