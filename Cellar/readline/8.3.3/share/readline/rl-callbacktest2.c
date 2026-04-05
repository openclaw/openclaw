/* Standard include files. stdio.h is required. */
#include <stdlib.h>
#include <unistd.h>
#include <string.h>

/* Used for select(2) */
#include <sys/types.h>
#include <sys/select.h>

#include <signal.h>

#include <errno.h>
#include <stdio.h>

#include <locale.h>

/* Standard readline include files. */
#if defined (READLINE_LIBRARY)
#  include "readline.h"
#  include "history.h"
#else
#  include <readline/readline.h>
#  include <readline/history.h>
#endif

#if !defined (errno)
extern int errno;
#endif

static void cb_linehandler (char *);
static void sigint_sighandler (int);
static int sigint_handler (int);

static int saw_signal = 0;

int running;
const char *prompt = "rltest$ ";
char *input_string;

/* Callback function called for each line when accept-line executed, EOF
   seen, or EOF character read.  This sets a flag and returns; it could
   also call exit(3). */
static void
cb_linehandler (char *line)
{
  if (line && *line)
    add_history (line);
  printf ("input line: %s\n", line ? line : "");
  input_string = line;
  rl_callback_handler_remove ();
}

static char *
cb_readline (void)
{
  fd_set fds;
  int r, err;
  char *not_done = "";

  /* Install the line handler. */
  rl_callback_handler_install (prompt, cb_linehandler);

  if (RL_ISSTATE (RL_STATE_ISEARCH))
    fprintf(stderr, "cb_readline: after handler install, state (ISEARCH) = %lu", rl_readline_state);
  else if (RL_ISSTATE (RL_STATE_NSEARCH))
    fprintf(stderr, "cb_readline: after handler install, state (NSEARCH) = %lu", rl_readline_state);
  /* MULTIKEY VIMOTION NUMERICARG _rl_callback_func */

  FD_ZERO (&fds);
  FD_SET (fileno (rl_instream), &fds);

  input_string = not_done;

  while (input_string == not_done)
    {
      r = err = 0;
      /* Enter a simple event loop.  This waits until something is available
	 to read on readline's input stream (defaults to standard input) and
	 calls the builtin character read callback to read it.  It does not
	 have to modify the user's terminal settings. */
      while (r == 0)
	{
	  struct timeval timeout = {0, 100000};
	  struct timeval *timeoutp = NULL;

	  timeoutp = &timeout;
	  FD_SET (fileno (rl_instream), &fds);
	  r = select (FD_SETSIZE, &fds, NULL, NULL, timeoutp);
	  err = errno;
	}

      if (saw_signal)
        sigint_handler (saw_signal);

      if (r < 0)
	{
	  perror ("rltest: select");
	  rl_callback_handler_remove ();
	  break;
	}

      /* if (FD_ISSET (fileno (rl_instream), &fds)) */
      if (r > 0)
	rl_callback_read_char ();
    }
  return input_string;
}

void
sigint_sighandler (int s)
{
  saw_signal = s;
}

int
sigint_handler (int s)
{
  rl_free_line_state ();
  rl_callback_sigcleanup ();
  rl_cleanup_after_signal ();
  rl_callback_handler_remove ();
  saw_signal = 0;
  return s;  
}

int
main (int c, char **v)
{
  char *p;

  setlocale (LC_ALL, "");

  running = 1;
  rl_catch_signals = 1;

  rl_bind_key_in_map ('r', rl_history_search_backward, emacs_meta_keymap);
  rl_bind_key_in_map ('s', rl_history_search_forward, emacs_meta_keymap);

  signal (SIGINT, sigint_sighandler);
  while (running)
    {
      p = cb_readline ();
      if (p == 0 || strcmp (p, "exit") == 0)
        break;
    }
  printf ("rl-callbacktest2: Event loop has exited\n");
  return 0;
}
