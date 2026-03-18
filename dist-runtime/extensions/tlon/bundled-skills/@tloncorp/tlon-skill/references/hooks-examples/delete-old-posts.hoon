:: Disappearing messages: deletes posts older than configured delay
:: From: https://github.com/tloncorp/hooks/blob/master/hooks/disappearing.hoon
:: Config: delay (default ~s30 = 30 seconds)
::
|=  [=event:h bowl:h]
^-  outcome:h
=-  &+[[[%allowed event] -] state.hook]
?.  ?=(%cron -.event)  ~
^-  (list effect:h)
=+  ;;(delay=@dr (~(gut by config) 'delay' ~s30))
=/  cutoff  (sub now delay)
?~  channel  ~
%+  murn
  (tap:on-v-posts:c (lot:on-v-posts:c posts.u.channel ~ `cutoff))
|=  [=id-post:c post=(may:c v-post:c)]
^-  (unit effect:h)
?:  ?=(%| -.post)  ~
`[%channels %channel nest.u.channel %post %del id-post]
