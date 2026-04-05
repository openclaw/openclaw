/* Standard include files. stdio.h is required. */
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <locale.h>

/* Used for select(2) */
#include <sys/types.h>
#include <sys/select.h>

#include <signal.h>

#include <stdio.h>

/* Standard readline include files. */
#include "readline.h"
#include "history.h"

static void cb_linehandler (char *);
static void sigwinch_handler (int);
static void sigint_handler (int);

int running;
int sigwinch_received;
int sigint_received;
const char *prompt = "rltest$ ";

/* Handle SIGWINCH and window size changes when readline is not active and
   reading a character. */
static void
sigwinch_handler (int sig)
{
  sigwinch_received = 1;
}

/* Handle SIGWINCH and window size changes when readline is not active and
   reading a character. */
static void
sigint_handler (int sig)
{
  sigint_received = 1;
}

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

/* replace with something more complex if desired */
static int
my_getc (FILE *stream)
{
  int ch = rl_getc (stream);

  return ch;
}


int
main (int c, char **v)
{
  fd_set fds;
  int r;

  /* Set the default locale values according to environment variables. */
  setlocale (LC_ALL, "");

  /* Handle window size changes when readline is not active and reading
     characters. */
#ifdef SIGWINCH
  signal (SIGWINCH, sigwinch_handler);
#endif
  signal (SIGINT, sigint_handler);

  rl_getc_function = my_getc;

  /* Install the line handler. */
  rl_callback_handler_install (prompt, cb_linehandler);

  /* Enter a simple event loop.  This waits until something is available
     to read on readline's input stream (defaults to standard input) and
     calls the builtin character read callback to read it.  It does not
     have to modify the user's terminal settings. */
  running = 1;
  while (running)
    {
      FD_ZERO (&fds);
      FD_SET (fileno (rl_instream), &fds);

      r = select (FD_SETSIZE, &fds, NULL, NULL, NULL);
      if (r < 0 && errno != EINTR)
        {
          perror ("rltest: select");
          rl_callback_handler_remove ();
          break;
        }
      if (sigwinch_received)
        {
          rl_resize_terminal ();
          sigwinch_received = 0;
        }
      if (sigint_received)
        {
          printf ("Quit\n");

          rl_callback_handler_remove ();
          rl_callback_handler_install (prompt, cb_linehandler);

          sigint_received = 0;
          continue;
        }
      if (r < 0)
        continue;

      if (FD_ISSET (fileno (rl_instream), &fds))
        rl_callback_read_char ();
    }

  printf ("rltest: Event loop has exited\n");
  return 0;
}
