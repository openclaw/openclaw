/* rl-timeout: test various readline builtin timeouts. */

/* Copyright (C) 2021 Free Software Foundation, Inc.

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
   along with readline.  If not, see <http://www.gnu.org/licenses/>.
*/

/* Standard include files. stdio.h is required. */
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <limits.h>

/* Used for select(2) */
#include <sys/types.h>
#include <sys/select.h>

#include <errno.h>
#include <stdio.h>

/* Standard readline include files. */
#if defined (READLINE_LIBRARY)
#  include "readline.h"
#  include "history.h"
#else
#  include <readline/readline.h>
#  include <readline/history.h>
#endif

extern int errno;

static void cb_linehandler (char *);

int timeout_secs = 1, timeout_usecs = 0;
int running;
const char *prompt = "rl-timeout$ ";

/* **************************************************************** */
/*								    */
/* Example 1: readline () with rl_readline_state		    */
/*								    */
/* **************************************************************** */

void
rltest_timeout_readline1 (void)
{
  const char *temp;

  rl_set_timeout (timeout_secs, timeout_usecs);
  temp = readline (prompt);
  if (RL_ISSTATE (RL_STATE_TIMEOUT))
    printf ("timeout\n");
  else if (temp == NULL)
    printf ("no input line\n");
  else
    printf ("input line: %s\n", temp);
  free ((void *) temp);
}

/* **************************************************************** */
/*								    */
/* Example 2: readline () with rl_timeout_event_hook		    */
/*								    */
/* **************************************************************** */

static int
timeout_handler (void)
{
  printf ("timeout\n");
  return READERR;
}

void
rltest_timeout_readline2 (void)
{
  const char *temp;

  rl_set_timeout (timeout_secs, timeout_usecs);
  rl_timeout_event_hook = timeout_handler;
  temp = readline (prompt);
  if (temp == NULL)
    printf ("no input line\n");
  else
    printf ("input line: %s\n", temp);
  free ((void *)temp);
}

/* **************************************************************** */
/*								    */
/* Example 3: rl_callback_* () with rl_timeout_remaining	    */
/*								    */
/* **************************************************************** */

/* Callback function called for each line when accept-line executed, EOF
   seen, or EOF character read.  This sets a flag and returns; it could
   also call exit(3). */
static void
cb_linehandler (char *line)
{
  /* Can use ^D (stty eof) or `exit' to exit. */
  if (line == NULL || strcmp (line, "exit") == 0)
    {
      if (line == 0)
	printf ("\n");
      printf ("exit\n");
      /* This function needs to be called to reset the terminal settings,
	 and calling it from the line handler keeps one extra prompt from
	 being displayed. */
      rl_callback_handler_remove ();

      running = 0;
    }
  else
    {
      if (*line)
	add_history (line);
      printf ("input line: %s\n", line);
      free (line);
    }
}

void
rltest_timeout_callback1 (void)
{
  fd_set fds;
  int r;
  unsigned sec, usec;

  rl_set_timeout (timeout_secs, timeout_usecs);
  rl_callback_handler_install (prompt, cb_linehandler);
  running = 1;
  while (running)
    {
      FD_ZERO (&fds);
      FD_SET (fileno (rl_instream), &fds);
      r = rl_timeout_remaining (&sec, &usec);
      if (r == 1)
	{
	  struct timeval timeout = {sec, usec};
	  r = select (FD_SETSIZE, &fds, NULL, NULL, &timeout);
	}
      if (r < 0 && errno != EINTR)
	{
	  perror ("rl-timeout: select");
	  rl_callback_handler_remove ();
	  break;
	}
      else if (r == 0)
	{
	  printf ("rl-timeout: timeout\n");
	  rl_callback_handler_remove ();
	  break;
	}

      if (FD_ISSET (fileno (rl_instream), &fds))
	rl_callback_read_char ();
    }

  printf ("rl-timeout: Event loop has exited\n");
}

/* **************************************************************** */
/*								    */
/* Example 4: rl_callback_* () with rl_timeout_event_hook	    */
/*								    */
/* **************************************************************** */

static int
cb_timeouthandler (void)
{
  printf ("timeout\n");
  rl_callback_handler_remove ();
  running = 0;
  return READERR;
}

void
rltest_timeout_callback2 (void)
{
  int r;

  rl_set_timeout (timeout_secs, timeout_usecs);
  rl_timeout_event_hook = cb_timeouthandler;
  rl_callback_handler_install (prompt, cb_linehandler);
  running = 1;
  while (running)
    rl_callback_read_char ();

  printf ("rl-timeout: Event loop has exited\n");
}

int
main (int argc, char **argv)
{
  if (argc >= 2)
    {
      if (argc >= 3)
	{
	  double timeout = atof (argv[2]);
	  if (timeout <= 0.0)
	    {
	      fprintf (stderr, "rl-timeout: specify a positive number for timeout.\n");
	      return 2;
	    }
	  else if (timeout > UINT_MAX)
	    {
	      fprintf (stderr, "rl-timeout: timeout too large.\n");
	      return 2;
	    }
	  timeout_secs = (unsigned) timeout;
	  timeout_usecs = (unsigned) ((timeout - timeout_secs) * 1000000 + 0.5);
	}

      if (strcmp (argv[1], "readline1") == 0)
	rltest_timeout_readline1 ();
      else if (strcmp (argv[1], "readline2") == 0)
	rltest_timeout_readline2 ();
      else if (strcmp (argv[1], "callback1") == 0)
	rltest_timeout_callback1 ();
      else if (strcmp (argv[1], "callback2") == 0)
	rltest_timeout_callback2 ();
      else
	return 2;
    }
  else
    {
      fprintf (stderr, "usage: rl-timeout [readline1 | readline2 | callback1 | callback2] [timeout]\n");
      return 2;
    }
  return 0;
}
