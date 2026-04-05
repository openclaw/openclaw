/* hist_purgecmd -- remove all instances of command or pattern from history
   file */

/* Copyright (C) 2011,2023 Free Software Foundation, Inc.

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
#ifndef READLINE_LIBRARY
#define READLINE_LIBRARY 1
#endif

#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>

#include <regex.h>

#ifdef READLINE_LIBRARY
#  include "history.h"
#else
#  include <readline/history.h>
#endif

#include <string.h>

#define STREQ(a, b) ((a)[0] == (b)[0] && strcmp(a, b) == 0)
#define STREQN(a, b, n) ((n == 0) ? (1) \
                                  : ((a)[0] == (b)[0] && strncmp(a, b, n) == 0))

#define PURGE_REGEXP	0x01

int hist_purgecmd (char *, int);

static void
usage(void)
{
  fprintf (stderr, "hist_purgecmd: usage: hist_purgecmd [-r] [-t] [-f filename] command-spec\n");
  exit (2);
}

int
main (int argc, char **argv)
{
  char *fn;
  int r, flags;

  flags = 0;
  fn = 0;
  while ((r = getopt (argc, argv, "f:rt")) != -1)
    {
      switch (r)
	{
	case 'f':
	  fn = optarg;
	  break;
	case 'r':
	  flags |= PURGE_REGEXP;
	  break;
	case 't':
	  history_write_timestamps = 1;
	  break;
	default:
	  usage ();
	}
    }
  argv += optind;
  argc -= optind;

  if (fn == 0)
    fn = getenv ("HISTFILE");
  if (fn == 0)
    {
      fprintf (stderr, "hist_purgecmd: no history file\n");
      usage ();
    }

  if ((r = read_history (fn)) != 0)
    {
      fprintf (stderr, "hist_purgecmd: read_history: %s: %s\n", fn, strerror (r));
      exit (1);
    }

  for (r = 0; r < argc; r++)
    hist_purgecmd (argv[r], flags);

  if ((r = write_history (fn)) != 0)
    {
      fprintf (stderr, "hist_purgecmd: write_history: %s: %s\n", fn, strerror (r));
      exit (1);
    }

  exit (0);
}

int
hist_purgecmd (char *cmd, int flags)
{
  int r, n, rflags;
  HIST_ENTRY *temp;
  regex_t regex = { 0 };

  if (flags & PURGE_REGEXP)
    {
      rflags = REG_EXTENDED|REG_NOSUB;
      if (regcomp (&regex, cmd, rflags))
	{
	  fprintf (stderr, "hist_purgecmd: %s: invalid regular expression\n", cmd);
	  return -1;
	}
    }

  r = 0;
  using_history ();
  r = where_history ();
  for (n = 0; n < r; n++)
    {
      temp = history_get (n+history_base);
      if (((flags & PURGE_REGEXP) && (regexec (&regex, temp->line, 0, 0, 0) == 0)) ||
	  ((flags & PURGE_REGEXP) == 0 && STREQ (temp->line, cmd)))
	{
	  remove_history (n);
	  r--;			/* have to get one fewer now */
	  n--;			/* compensate for above increment */
	  history_offset--;	/* moving backwards in history list */
	}
    }
  using_history ();

  if (flags & PURGE_REGEXP)
    regfree (&regex);

  return r;
}
